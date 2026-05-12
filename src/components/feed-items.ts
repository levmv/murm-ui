import type { Message } from "../core/types";

export type FeedItem = Message | FeedAgentRunItem;

export interface FeedAgentRunItem {
	type: "agent_run";
	id: string;
	runId: string;
	userMessage: Message;
	stepMessages: readonly Message[];
	finalMessage: Message;
	collapsed: boolean;
	durationMs?: number;
}

export interface BuildFeedItemsOptions {
	generatingMessageId: string | null;
	isRunExpanded: (runId: string) => boolean;
	minAgentRunSteps?: number;
}

const DEFAULT_MIN_AGENT_RUN_STEPS = 1;

export function buildFeedItems(messages: readonly Message[], options: BuildFeedItemsOptions): readonly FeedItem[] {
	const items: FeedItem[] = [];
	const minAgentRunSteps = options.minAgentRunSteps ?? DEFAULT_MIN_AGENT_RUN_STEPS;

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];

		if (message.role === "user") {
			const runEndIndex = findRunEndIndex(messages, index);
			const runItem =
				runEndIndex - index >= 3 ? buildAgentRunItem(messages, index, runEndIndex, options, minAgentRunSteps) : null;

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

export function isAgentRunItem(item: FeedItem): item is FeedAgentRunItem {
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

function buildAgentRunItem(
	messages: readonly Message[],
	userIndex: number,
	runEndIndex: number,
	options: BuildFeedItemsOptions,
	minAgentRunSteps: number,
): FeedAgentRunItem | null {
	if (options.generatingMessageId) {
		for (let i = userIndex; i < runEndIndex; i++) {
			if (messages[i].id === options.generatingMessageId) return null;
		}
	}

	const userMessage = messages[userIndex];
	const finalMessageIndex = findFinalAssistantTextIndex(messages, userIndex + 1, runEndIndex);
	if (finalMessageIndex !== runEndIndex - 1) return null;

	let agentStepCount = 0;
	for (let i = userIndex + 1; i < finalMessageIndex; i++) {
		if (hasAgentActivity(messages[i])) agentStepCount++;
	}
	if (agentStepCount < minAgentRunSteps) return null;

	const stepMessages: Message[] = [];
	for (let i = userIndex + 1; i < finalMessageIndex; i++) {
		if (hasVisibleContent(messages[i])) stepMessages.push(messages[i]);
	}

	const runId = userMessage.runId ?? userMessage.id;

	return {
		type: "agent_run",
		id: `agent-run:${runId}`,
		runId,
		userMessage,
		stepMessages,
		finalMessage: messages[finalMessageIndex],
		collapsed: !options.isRunExpanded(runId),
		durationMs: calculateRunDuration(userMessage, messages[finalMessageIndex]),
	};
}

function findFinalAssistantTextIndex(messages: readonly Message[], startIndex: number, endIndex: number): number {
	for (let i = endIndex - 1; i >= startIndex; i--) {
		const message = messages[i];
		if (message.role === "assistant" && hasTextBlock(message)) return i;
	}

	return -1;
}

function hasTextBlock(message: Message): boolean {
	return message.blocks.some((block) => block.type === "text" && block.text.trim().length > 0);
}

function hasAgentActivity(message: Message): boolean {
	return message.blocks.some((block) => block.type !== "text" && hasVisibleBlock(block));
}

function hasVisibleContent(message: Message): boolean {
	return message.blocks.some(hasVisibleBlock);
}

function hasVisibleBlock(block: Message["blocks"][number]): boolean {
	switch (block.type) {
		case "text":
			return block.text.trim().length > 0;
		case "reasoning":
			return block.encrypted === true || block.text.trim().length > 0 || Boolean(block.encryptedText);
		case "tool_call":
		case "tool_result":
		case "artifact":
		case "file":
			return true;
	}
}

function calculateRunDuration(userMessage: Message, finalMessage: Message): number | undefined {
	const startedAt = userMessage.updatedAt ?? userMessage.createdAt;
	const finishedAt = finalMessage.updatedAt ?? finalMessage.createdAt;
	if (startedAt === undefined || finishedAt === undefined) return undefined;
	if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) return undefined;
	return finishedAt - startedAt;
}
