import type { AgentRunCollapse, ContentBlock, Message } from "../core/types";

export type FeedItem = Message | RunItem;

export type RunSegment = MessageSegment | WorkSegment;

export interface MessageSegment {
	type: "messages";
	id: string;
	messages: readonly Message[];
}

export interface WorkSegment {
	type: "work";
	id: string;
	messages: readonly Message[];
	collapsed: boolean;
	durationMs?: number;
}

export interface RunItem {
	type: "agent_run";
	id: string;
	runId: string;
	userMessage: Message;
	segments: readonly RunSegment[];
}

export interface FeedOptions {
	streamingMessageIds?: ReadonlySet<string>;
	showReasoning?: boolean;
	isExpanded?: (segmentId: string) => boolean;
	minAgentRunSteps?: number;
	agentRunCollapse?: AgentRunCollapse;
}

const DEFAULT_MIN_AGENT_RUN_STEPS = 1;
const DEFAULT_AGENT_RUN_COLLAPSE: AgentRunCollapse = "machinery";

export function buildFeedItems(messages: readonly Message[], options: FeedOptions): readonly FeedItem[] {
	if (options.showReasoning === false) {
		messages = messages.map((message) =>
			message.blocks.some((block) => block.type === "reasoning")
				? { ...message, blocks: message.blocks.filter((block) => block.type !== "reasoning") }
				: message,
		);
	}
	const items: FeedItem[] = [];
	const minAgentRunSteps = options.minAgentRunSteps ?? DEFAULT_MIN_AGENT_RUN_STEPS;
	const agentRunCollapse = options.agentRunCollapse ?? DEFAULT_AGENT_RUN_COLLAPSE;

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];

		if (message.role === "user") {
			const runEndIndex = findRunEndIndex(messages, index);
			const runItem =
				runEndIndex - index >= 2
					? buildRun(messages, index, runEndIndex, options, minAgentRunSteps, agentRunCollapse)
					: null;

			if (runItem) {
				items.push(runItem);
				index = runEndIndex - 1;
				continue;
			}
		}

		items.push(message);
	}

	return items;
}

export function isAgentRunItem(item: FeedItem): item is RunItem {
	return "type" in item && item.type === "agent_run";
}

export function feedItemType(item: FeedItem): "message" | "agent_run" {
	return isAgentRunItem(item) ? "agent_run" : "message";
}

function findRunEndIndex(messages: readonly Message[], userIndex: number): number {
	const userMessage = messages[userIndex];
	const runId = userMessage.runId;
	let endIndex = userIndex + 1;

	if (runId) {
		while (endIndex < messages.length && messages[endIndex].role !== "user" && messages[endIndex].runId === runId) {
			endIndex++;
		}
	} else {
		while (endIndex < messages.length && messages[endIndex].role !== "user" && !messages[endIndex].runId) {
			endIndex++;
		}
	}

	return endIndex;
}

function buildRun(
	messages: readonly Message[],
	userIndex: number,
	runEndIndex: number,
	options: FeedOptions,
	minAgentRunSteps: number,
	agentRunCollapse: AgentRunCollapse,
): RunItem | null {
	let isActiveRun = false;
	if (options.streamingMessageIds?.size) {
		for (let i = userIndex; i < runEndIndex; i++) {
			if (!options.streamingMessageIds.has(messages[i].id)) continue;
			if (agentRunCollapse !== "machinery") return null;
			isActiveRun = true;
			break;
		}
	}

	const userMessage = messages[userIndex];
	const finalMessageIndex = findFinalReplyIndex(messages, userIndex + 1, runEndIndex);
	if (finalMessageIndex === -1 && !isActiveRun) return null;
	if (agentRunCollapse === "full" && finalMessageIndex !== runEndIndex - 1) return null;

	const runId = userMessage.runId ?? userMessage.id;
	const isExpanded = (segmentId: string) => isActiveRun || options.isExpanded?.(segmentId) || false;
	const segments =
		agentRunCollapse === "full"
			? buildFullSegments(messages, userIndex, finalMessageIndex, runId, isExpanded)
			: buildMachinerySegments(messages, userIndex, runEndIndex, runId, isExpanded);
	const stepIds = new Set<string>();
	for (const segment of segments) {
		if (segment.type === "work") for (const message of segment.messages) stepIds.add(message.id);
	}
	if (stepIds.size < minAgentRunSteps) return null;

	return {
		type: "agent_run",
		id: `agent-run:${runId}`,
		runId,
		userMessage,
		segments,
	};
}

function buildFullSegments(
	messages: readonly Message[],
	userIndex: number,
	finalMessageIndex: number,
	runId: string,
	isExpanded: (segmentId: string) => boolean,
): RunSegment[] {
	const stepMessages = buildFullStepMessages(messages, userIndex + 1, finalMessageIndex);
	const finalMachineryBlocks = machineryBlocks(messages[finalMessageIndex]);
	if (finalMachineryBlocks.length > 0) {
		stepMessages.push({ ...messages[finalMessageIndex], blocks: finalMachineryBlocks });
	}

	const visibleFinalBlocks = proseBlocks(messages[finalMessageIndex]);
	const segments: RunSegment[] = [];
	if (stepMessages.length > 0) {
		const id = `${runId}:work:0`;
		segments.push({
			type: "work",
			id,
			messages: stepMessages,
			collapsed: !isExpanded(id),
			durationMs: calculateRunDuration(messages[userIndex], messages[finalMessageIndex]),
		});
	}
	if (visibleFinalBlocks.length > 0) {
		segments.push({
			type: "messages",
			id: `${runId}:messages:0`,
			messages: [{ ...messages[finalMessageIndex], blocks: visibleFinalBlocks }],
		});
	}
	return segments;
}

function buildFullStepMessages(messages: readonly Message[], startIndex: number, finalMessageIndex: number): Message[] {
	const stepMessages: Message[] = [];
	for (let i = startIndex; i < finalMessageIndex; i++) {
		const stepBlocks = messages[i].blocks.filter(isRenderableStepBlock);
		if (stepBlocks.length > 0) stepMessages.push({ ...messages[i], blocks: stepBlocks });
	}
	return stepMessages;
}

function buildMachinerySegments(
	messages: readonly Message[],
	userIndex: number,
	runEndIndex: number,
	runId: string,
	isExpanded: (segmentId: string) => boolean,
): RunSegment[] {
	const segments: RunSegment[] = [];
	let pendingKind: "messages" | "work" | null = null;
	let pendingMessages: Message[] = [];

	const flush = () => {
		if (!pendingKind || pendingMessages.length === 0) return;
		const index = segments.length;
		if (pendingKind === "messages") {
			segments.push({
				type: "messages",
				id: `${runId}:messages:${index}`,
				messages: pendingMessages,
			});
		} else {
			const id = `${runId}:work:${index}`;
			segments.push({
				type: "work",
				id,
				messages: pendingMessages,
				collapsed: !isExpanded(id),
			});
		}
		pendingKind = null;
		pendingMessages = [];
	};

	const append = (kind: "messages" | "work", message: Message, blocks: ContentBlock[]) => {
		if (blocks.length === 0) return;
		if (pendingKind !== kind) flush();
		pendingKind = kind;
		pendingMessages.push({ ...message, blocks });
	};

	for (let i = userIndex + 1; i < runEndIndex; i++) {
		appendMessageChunks(messages[i], append);
	}

	flush();
	mergeLeadingReasoning(segments);
	applyWorkDurations(segments, messages[userIndex]);
	return segments;
}

function appendMessageChunks(
	message: Message,
	append: (kind: "messages" | "work", message: Message, blocks: ContentBlock[]) => void,
): void {
	if (message.role !== "assistant") {
		append("work", message, message.blocks.filter(isRenderableStepBlock));
		return;
	}

	let currentKind: "messages" | "work" | null = null;
	let currentBlocks: ContentBlock[] = [];

	const flush = () => {
		if (!currentKind || currentBlocks.length === 0) return;
		append(currentKind, message, currentBlocks);
		currentKind = null;
		currentBlocks = [];
	};

	for (const block of message.blocks) {
		const kind = blockKind(block);
		if (!kind) continue;
		if (currentKind !== kind) flush();
		currentKind = kind;
		currentBlocks.push(block);
	}

	flush();
}

function blockKind(block: ContentBlock): "messages" | "work" | null {
	if (isProseBlock(block)) return "messages";
	if (isCollapsibleBlock(block)) return "work";
	return null;
}

function applyWorkDurations(segments: RunSegment[], userMessage: Message): void {
	let previousVisibleMessage = userMessage;

	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		if (segment.type === "messages") {
			previousVisibleMessage = segment.messages[segment.messages.length - 1] ?? previousVisibleMessage;
			continue;
		}

		const nextVisibleMessage = findNextVisibleMessage(segments, i + 1);
		const lastStepMessage = segment.messages[segment.messages.length - 1];
		if (!lastStepMessage) continue;
		const boundaryDurationMs = nextVisibleMessage
			? calculateRunDuration(previousVisibleMessage, nextVisibleMessage)
			: calculateRunDuration(previousVisibleMessage, lastStepMessage);
		if (boundaryDurationMs !== undefined) segment.durationMs = boundaryDurationMs;
	}
}

function findNextVisibleMessage(segments: readonly RunSegment[], startIndex: number): Message | undefined {
	for (let i = startIndex; i < segments.length; i++) {
		const segment = segments[i];
		if (segment.type === "messages") return segment.messages[0];
	}
	return undefined;
}

function mergeLeadingReasoning(segments: RunSegment[]): void {
	const firstSegment = segments[0];
	const secondSegment = segments[1];
	if (firstSegment?.type !== "work" || secondSegment?.type !== "messages") return;
	if (!isReasoningOnly(firstSegment)) return;

	const nextWorkIndex = segments.findIndex((segment, index) => index > 1 && segment.type === "work");
	if (nextWorkIndex === -1) return;

	const nextWorkSegment = segments[nextWorkIndex];
	if (nextWorkSegment.type !== "work") return;

	segments[nextWorkIndex] = {
		...nextWorkSegment,
		messages: [...firstSegment.messages, ...nextWorkSegment.messages],
	};
	segments.shift();
}

function isReasoningOnly(segment: WorkSegment): boolean {
	return segment.messages.every(
		(message) =>
			message.role === "assistant" &&
			message.blocks.length > 0 &&
			message.blocks.every((block) => block.type === "reasoning"),
	);
}

function findFinalReplyIndex(messages: readonly Message[], startIndex: number, endIndex: number): number {
	for (let i = endIndex - 1; i >= startIndex; i--) {
		const message = messages[i];
		if (message.role === "assistant" && proseBlocks(message).length > 0) return i;
	}

	return -1;
}

function machineryBlocks(message: Message): ContentBlock[] {
	if (message.role !== "assistant") return message.blocks.filter(isRenderableStepBlock);
	return message.blocks.filter(isCollapsibleBlock);
}

function proseBlocks(message: Message): ContentBlock[] {
	if (message.role !== "assistant") return [];
	return message.blocks.filter(isProseBlock);
}

function isProseBlock(block: ContentBlock): boolean {
	switch (block.type) {
		case "text":
			return block.text.trim().length > 0;
		case "artifact":
		case "custom":
		case "file":
			return true;
		case "reasoning":
		case "tool_call":
		case "tool_result":
			return false;
	}
}

function isCollapsibleBlock(block: ContentBlock): boolean {
	switch (block.type) {
		case "reasoning":
			return hasVisibleBlock(block);
		case "tool_call":
			return true;
		case "tool_result":
		case "text":
		case "artifact":
		case "custom":
		case "file":
			return false;
	}
}

function hasVisibleBlock(block: ContentBlock): boolean {
	switch (block.type) {
		case "text":
			return block.text.trim().length > 0;
		case "reasoning":
			return block.encrypted === true || block.text.trim().length > 0 || Boolean(block.encryptedText);
		case "tool_call":
		case "tool_result":
		case "artifact":
		case "custom":
		case "file":
			return true;
	}
}

function isRenderableStepBlock(block: ContentBlock): boolean {
	return block.type !== "tool_result" && hasVisibleBlock(block);
}

function calculateRunDuration(userMessage: Message, finalMessage: Message): number | undefined {
	const startedAt = userMessage.updatedAt ?? userMessage.createdAt;
	const finishedAt = finalMessage.updatedAt ?? finalMessage.createdAt;
	if (startedAt === undefined || finishedAt === undefined) return undefined;
	if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) return undefined;
	return finishedAt - startedAt;
}
