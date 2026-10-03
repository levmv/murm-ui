import type { Message, RenderConfig } from "../core/types";
import { defaultLabels } from "../labels";
import { ICON_CHEVRON } from "../utils/icons";
import { type FeedItem, isAgentRunItem, type RunItem, type RunSegment, type WorkSegment } from "./feed-items";
import { MessageNode } from "./message-node";

export interface FeedContext {
	messages: readonly Message[];
	messagesById: ReadonlyMap<string, Message>;
	streamingMessageIds?: ReadonlySet<string>;
	/** Present only when grouping and node structure are unchanged. */
	dirtyMessageIds?: ReadonlySet<string>;
	onToggleWorkSegment: (segmentId: string) => void;
}

export interface FeedNode {
	type: "message" | "agent_run";
	el: HTMLElement;
	update(item: FeedItem, ctx: FeedContext): void;
	destroy(): void;
}

export function createFeedNode(item: FeedItem, config: RenderConfig): FeedNode {
	return isAgentRunItem(item) ? new RunNode(item, config) : new MessageFeedNode(item, config);
}

class MessageFeedNode implements FeedNode {
	public readonly type = "message";
	public readonly el: HTMLElement;
	private readonly messageNode: MessageNode;

	constructor(message: Message, config: RenderConfig) {
		this.messageNode = new MessageNode(message, config);
		this.el = this.messageNode.el;
	}

	public update(item: FeedItem, ctx: FeedContext): void {
		if (isAgentRunItem(item)) return;
		updateMessageNode(this.messageNode, item, ctx);
	}

	public destroy(): void {
		this.messageNode.destroy();
	}
}

class RunNode implements FeedNode {
	public readonly type = "agent_run";
	public readonly el = document.createElement("div");

	private readonly segmentNodes = new Map<string, SegmentNode>();

	private userNode?: MessageNode;
	private userMessageId?: string;

	constructor(
		item: RunItem,
		private readonly config: RenderConfig,
	) {
		this.el.className = "mur-agent-run";
		this.el.dataset.runId = item.runId;
	}

	public update(item: FeedItem, ctx: FeedContext): void {
		if (!isAgentRunItem(item)) return;
		if (ctx.dirtyMessageIds) {
			if (this.userNode) updateMessageNode(this.userNode, item.userMessage, ctx);
			for (const segment of item.segments) this.segmentNodes.get(segment.id)?.update(segment, ctx);
			return;
		}

		this.renderUserMessage(item.userMessage, ctx);
		this.renderSegments(item.segments, ctx);
	}

	public destroy(): void {
		this.userNode?.destroy();
		for (const node of this.segmentNodes.values()) {
			node.destroy();
		}
		this.segmentNodes.clear();
		this.el.remove();
	}

	private renderUserMessage(message: Message, ctx: FeedContext): void {
		if (!this.userNode || this.userMessageId !== message.id) {
			this.userNode?.destroy();
			this.userNode = new MessageNode(message, this.config);
			this.userMessageId = message.id;
		}

		updateMessageNode(this.userNode, message, ctx);
		if (this.el.firstElementChild !== this.userNode.el) {
			this.el.insertBefore(this.userNode.el, this.el.firstChild);
		}
	}

	private renderSegments(segments: readonly RunSegment[], ctx: FeedContext): void {
		let previousEl: Element | null = this.userNode?.el ?? null;

		for (const segment of segments) {
			let node = this.segmentNodes.get(segment.id);

			if (!node || node.type !== segment.type) {
				node?.destroy();
				node = createSegmentNode(segment, this.config);
				this.segmentNodes.set(segment.id, node);
			}

			if (node.el.parentElement !== this.el || node.el.previousElementSibling !== previousEl) {
				this.el.insertBefore(node.el, previousEl ? previousEl.nextSibling : this.el.firstChild);
			}

			node.update(segment, ctx);
			previousEl = node.el;
		}

		const currentIds = new Set<string>();
		for (const segment of segments) {
			currentIds.add(segment.id);
		}
		for (const [id, node] of this.segmentNodes) {
			if (currentIds.has(id)) continue;
			node.destroy();
			this.segmentNodes.delete(id);
		}
	}
}

interface SegmentNode {
	type: RunSegment["type"];
	el: HTMLElement;
	update(segment: RunSegment, ctx: FeedContext): void;
	destroy(): void;
}

function createSegmentNode(segment: RunSegment, config: RenderConfig): SegmentNode {
	return segment.type === "work" ? new WorkNode(segment, config) : new MessagesNode(config);
}

class MessagesNode implements SegmentNode {
	public readonly type = "messages";
	public readonly el = document.createElement("div");

	private readonly messageNodes = new Map<string, MessageNode>();

	constructor(private readonly config: RenderConfig) {
		this.el.className = "mur-agent-run-messages";
	}

	public update(segment: RunSegment, ctx: FeedContext): void {
		if (segment.type !== "messages") return;
		if (ctx.dirtyMessageIds) {
			updateDirtyMessageNodes(segment.messages, this.messageNodes, ctx);
			return;
		}

		syncMessages(this.el, this.messageNodes, segment.messages, this.config, ctx);
	}

	public destroy(): void {
		clearMessageNodes(this.messageNodes);
		this.el.remove();
	}
}

class WorkNode implements SegmentNode {
	public readonly type = "work";
	public readonly el = document.createElement("div");

	private readonly summaryEl = document.createElement("button");
	private readonly chevronEl = document.createElement("span");
	private readonly labelEl = document.createElement("span");
	private readonly stepsEl = document.createElement("div");
	private readonly stepNodes = new Map<string, MessageNode>();
	private currentSegmentId?: string;
	private onToggleWorkSegment?: (segmentId: string) => void;

	constructor(
		segment: WorkSegment,
		private readonly config: RenderConfig,
	) {
		this.currentSegmentId = segment.id;
		this.el.className = "mur-agent-run-work";
		this.el.dataset.segmentId = segment.id;

		this.summaryEl.type = "button";
		this.summaryEl.className = "mur-agent-run-summary";
		this.summaryEl.addEventListener("click", () => {
			if (this.currentSegmentId) this.onToggleWorkSegment?.(this.currentSegmentId);
		});

		this.chevronEl.className = "mur-agent-run-summary-chevron";
		this.chevronEl.innerHTML = ICON_CHEVRON;
		this.labelEl.className = "mur-agent-run-summary-label";
		this.summaryEl.append(this.chevronEl, this.labelEl);

		this.stepsEl.className = "mur-agent-run-steps";
		this.el.append(this.summaryEl, this.stepsEl);
	}

	public update(segment: RunSegment, ctx: FeedContext): void {
		if (segment.type !== "work") return;
		if (ctx.dirtyMessageIds) {
			if (!segment.collapsed) updateDirtyMessageNodes(segment.messages, this.stepNodes, ctx);
			return;
		}

		this.currentSegmentId = segment.id;
		if (this.el.dataset.segmentId !== segment.id) this.el.dataset.segmentId = segment.id;
		this.onToggleWorkSegment = ctx.onToggleWorkSegment;
		this.renderSummary(segment);
		this.renderSteps(segment, ctx);
	}

	public destroy(): void {
		clearMessageNodes(this.stepNodes);
		this.el.remove();
	}

	private renderSummary(segment: WorkSegment): void {
		const label = (this.config.labels ?? defaultLabels).workSummary(
			countToolCalls(segment),
			isReasoningOnlySegment(segment),
			segment.durationMs,
		);
		if (this.labelEl.textContent !== label) this.labelEl.textContent = label;
		const expanded = String(!segment.collapsed);
		if (this.summaryEl.getAttribute("aria-expanded") !== expanded)
			this.summaryEl.setAttribute("aria-expanded", expanded);
	}

	private renderSteps(segment: WorkSegment, ctx: FeedContext): void {
		if (this.stepsEl.hidden !== segment.collapsed) this.stepsEl.hidden = segment.collapsed;

		if (segment.collapsed) {
			clearMessageNodes(this.stepNodes);
			return;
		}

		syncMessages(this.stepsEl, this.stepNodes, segment.messages, this.config, ctx);
	}
}

function syncMessages(
	container: HTMLElement,
	nodes: Map<string, MessageNode>,
	messages: readonly Message[],
	config: RenderConfig,
	ctx: FeedContext,
): void {
	const ids = new Set<string>();
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		const key = messageNodeKey(message);
		ids.add(key);
		let node = nodes.get(key);
		if (!node) {
			node = new MessageNode(message, config);
			nodes.set(key, node);
		}
		if (container.children[index] !== node.el) container.insertBefore(node.el, container.children[index]);
		updateMessageNode(node, message, ctx);
	}
	for (const [id, node] of nodes) {
		if (ids.has(id)) continue;
		node.destroy();
		nodes.delete(id);
	}
}

function updateDirtyMessageNodes(
	messages: readonly Message[],
	nodes: Map<string, MessageNode>,
	ctx: FeedContext,
): void {
	for (const message of messages) {
		if (!ctx.dirtyMessageIds!.has(message.id)) continue;
		const node = nodes.get(messageNodeKey(message));
		if (node) updateMessageNode(node, message, ctx);
	}
}

function updateMessageNode(node: MessageNode, message: Message, ctx: FeedContext): void {
	if (ctx.dirtyMessageIds && !ctx.dirtyMessageIds.has(message.id)) return;
	// Feed items cache block projections, not message metadata. Resolve the
	// canonical message in O(1), retaining only the projection's selected blocks.
	const source = ctx.messagesById.get(message.id)!;
	const current = source === message ? message : { ...source, blocks: message.blocks };
	node.update(current, ctx.streamingMessageIds?.has(message.id) === true, current.error ?? null, ctx.messages);
}

function messageNodeKey(message: Message): string {
	// A message can have multiple chunks in a segment. Its first block identifies
	// the chunk; appending blocks must not remount existing interactive cards.
	return JSON.stringify([message.id, message.blocks[0]?.id]);
}

function clearMessageNodes(nodes: Map<string, MessageNode>): void {
	for (const node of nodes.values()) {
		node.destroy();
	}
	nodes.clear();
}

function countToolCalls(segment: WorkSegment): number {
	let count = 0;
	for (const message of segment.messages) {
		for (const block of message.blocks) {
			if (block.type === "tool_call") count++;
		}
	}
	return count;
}

function isReasoningOnlySegment(segment: WorkSegment): boolean {
	let hasReasoning = false;
	for (const message of segment.messages) {
		for (const block of message.blocks) {
			if (block.type !== "reasoning") return false;
			hasReasoning = true;
		}
	}
	return hasReasoning;
}
