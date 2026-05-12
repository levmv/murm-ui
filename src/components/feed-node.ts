import type { Message, RenderConfig } from "../core/types";
import { ICON_CHEVRON } from "../utils/icons";
import { type FeedAgentRunItem, type FeedItem, isAgentRunItem } from "./feed-items";
import { MessageNode } from "./message-node";

export interface FeedNodeUpdateContext {
	messages: readonly Message[];
	generatingMessageId: string | null;
	error: { message: string; id?: string } | null;
	onToggleRun: (runId: string) => void;
}

export interface FeedNode {
	type: "message" | "agent_run";
	el: HTMLElement;
	update(item: FeedItem, ctx: FeedNodeUpdateContext): void;
	destroy(): void;
}

export function createFeedNode(item: FeedItem, config: RenderConfig): FeedNode {
	return isAgentRunItem(item) ? new AgentRunFeedNode(item, config) : new MessageFeedNode(item, config);
}

class MessageFeedNode implements FeedNode {
	public readonly type = "message";
	public readonly el: HTMLElement;
	private readonly messageNode: MessageNode;

	constructor(message: Message, config: RenderConfig) {
		this.messageNode = new MessageNode(message, config);
		this.el = this.messageNode.el;
	}

	public update(item: FeedItem, ctx: FeedNodeUpdateContext): void {
		if (isAgentRunItem(item)) return;
		updateMessageNode(this.messageNode, item, ctx);
	}

	public destroy(): void {
		this.messageNode.destroy();
	}
}

class AgentRunFeedNode implements FeedNode {
	public readonly type = "agent_run";
	public readonly el = document.createElement("div");

	private readonly summaryEl = document.createElement("button");
	private readonly chevronEl = document.createElement("span");
	private readonly labelEl = document.createElement("span");
	private readonly stepsEl = document.createElement("div");
	private readonly stepNodes = new Map<string, MessageNode>();

	private userNode?: MessageNode;
	private userMessageId?: string;
	private finalNode?: MessageNode;
	private finalMessageId?: string;
	private currentRunId?: string;
	private onToggleRun?: (runId: string) => void;

	constructor(
		item: FeedAgentRunItem,
		private readonly config: RenderConfig,
	) {
		this.el.className = "mur-agent-run";
		this.el.dataset.runId = item.runId;

		this.summaryEl.type = "button";
		this.summaryEl.className = "mur-agent-run-summary";
		this.summaryEl.addEventListener("click", () => {
			if (this.currentRunId) this.onToggleRun?.(this.currentRunId);
		});

		this.chevronEl.className = "mur-agent-run-summary-chevron";
		this.chevronEl.innerHTML = ICON_CHEVRON;
		this.labelEl.className = "mur-agent-run-summary-label";
		this.summaryEl.append(this.chevronEl, this.labelEl);

		this.stepsEl.className = "mur-agent-run-steps";
		this.el.append(this.summaryEl, this.stepsEl);
	}

	public update(item: FeedItem, ctx: FeedNodeUpdateContext): void {
		if (!isAgentRunItem(item)) return;

		this.currentRunId = item.runId;
		this.onToggleRun = ctx.onToggleRun;
		this.el.dataset.runId = item.runId;

		this.renderUserMessage(item.userMessage, ctx);
		this.renderSummary(item);
		this.renderSteps(item, ctx);
		this.renderFinalMessage(item.finalMessage, ctx);
	}

	public destroy(): void {
		this.userNode?.destroy();
		this.finalNode?.destroy();
		clearMessageNodes(this.stepNodes);
		this.el.remove();
	}

	private renderUserMessage(message: Message, ctx: FeedNodeUpdateContext): void {
		if (!this.userNode || this.userMessageId !== message.id) {
			this.userNode?.destroy();
			this.userNode = new MessageNode(message, this.config);
			this.userMessageId = message.id;
		}

		updateMessageNode(this.userNode, message, ctx);
		if (this.summaryEl.previousElementSibling !== this.userNode.el) {
			this.el.insertBefore(this.userNode.el, this.summaryEl);
		}
	}

	private renderSummary(item: FeedAgentRunItem): void {
		this.labelEl.textContent =
			item.durationMs === undefined ? "Worked" : `Worked for ${formatDuration(item.durationMs)}`;
		this.summaryEl.setAttribute("aria-expanded", String(!item.collapsed));
	}

	private renderSteps(item: FeedAgentRunItem, ctx: FeedNodeUpdateContext): void {
		this.stepsEl.hidden = item.collapsed;

		if (item.collapsed) {
			clearMessageNodes(this.stepNodes);
			return;
		}

		for (let index = 0; index < item.stepMessages.length; index++) {
			const message = item.stepMessages[index];
			let node = this.stepNodes.get(message.id);

			if (!node) {
				node = new MessageNode(message, this.config);
				this.stepNodes.set(message.id, node);
			}

			if (this.stepsEl.children[index] !== node.el) {
				this.stepsEl.insertBefore(node.el, this.stepsEl.children[index]);
			}

			updateMessageNode(node, message, ctx);
		}

		const currentIds = new Set<string>();
		for (const message of item.stepMessages) {
			currentIds.add(message.id);
		}
		for (const [id, node] of this.stepNodes) {
			if (currentIds.has(id)) continue;
			node.destroy();
			this.stepNodes.delete(id);
		}
	}

	private renderFinalMessage(message: Message, ctx: FeedNodeUpdateContext): void {
		if (!this.finalNode || this.finalMessageId !== message.id) {
			this.finalNode?.destroy();
			this.finalNode = new MessageNode(message, this.config);
			this.finalMessageId = message.id;
		}

		updateMessageNode(this.finalNode, message, ctx);
		if (this.finalNode.el.parentElement !== this.el || this.finalNode.el.previousElementSibling !== this.stepsEl) {
			this.el.insertBefore(this.finalNode.el, this.stepsEl.nextSibling);
		}
	}
}

function updateMessageNode(node: MessageNode, message: Message, ctx: FeedNodeUpdateContext): void {
	const targetError = ctx.error?.id === message.id ? ctx.error.message : null;
	node.update(message, message.id === ctx.generatingMessageId, targetError, ctx.messages);
}

function clearMessageNodes(nodes: Map<string, MessageNode>): void {
	for (const node of nodes.values()) {
		node.destroy();
	}
	nodes.clear();
}

function formatDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
