import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../core/types";
import { buildFeedItems, isAgentRunItem, type RunItem } from "./feed-items";

function onlyAgentRun(messages: Message[], options: Partial<Parameters<typeof buildFeedItems>[1]> = {}) {
	const items = buildFeedItems(messages, options);
	assert.equal(items.length, 1);
	assert.ok(isAgentRunItem(items[0]));
	return items[0];
}

function runWithIntermediateProse(intermediateText = "Верно, playground/ - мое. Давай уберу это сейчас."): Message[] {
	return [
		{
			id: "user-134",
			role: "user",
			runId: "run-29",
			blocks: [{ id: "user-text", type: "text", text: "Clean it up" }],
		},
		{
			id: "assistant-135",
			role: "assistant",
			runId: "run-29",
			blocks: [
				{ id: "assistant-135-reasoning", type: "reasoning", text: "Need to inspect the workspace." },
				{ id: "assistant-135-text", type: "text", text: intermediateText },
				{
					id: "assistant-135-tool",
					type: "tool_call",
					toolCallId: "call-135",
					name: "edit",
					argsText: "{}",
					status: "complete",
				},
			],
		},
		{
			id: "tool-136",
			role: "tool",
			runId: "run-29",
			blocks: [{ id: "tool-136-result", type: "tool_result", toolCallId: "call-135", outputText: "ok" }],
		},
		{
			id: "assistant-137",
			role: "assistant",
			runId: "run-29",
			blocks: [
				{
					id: "assistant-137-tool",
					type: "tool_call",
					toolCallId: "call-137",
					name: "memory",
					argsText: "{}",
					status: "complete",
				},
			],
		},
		{
			id: "tool-138",
			role: "tool",
			runId: "run-29",
			blocks: [
				{
					id: "tool-138-result",
					type: "tool_result",
					toolCallId: "call-137",
					outputText: "memory created",
				},
			],
		},
		{
			id: "assistant-139",
			role: "assistant",
			runId: "run-29",
			blocks: [{ id: "assistant-139-text", type: "text", text: "Вот, теперь в memory/random-ideas.md." }],
		},
	];
}

function runWithoutIntermediateProse(): Message[] {
	return [
		{
			id: "user-1",
			role: "user",
			runId: "run-1",
			blocks: [{ id: "user-text", type: "text", text: "List files" }],
		},
		{
			id: "assistant-tool",
			role: "assistant",
			runId: "run-1",
			blocks: [
				{
					id: "tool-call",
					type: "tool_call",
					toolCallId: "call-1",
					name: "list_files",
					argsText: "{}",
					status: "complete",
				},
			],
		},
		{
			id: "tool-result",
			role: "tool",
			runId: "run-1",
			blocks: [{ id: "tool-result-block", type: "tool_result", toolCallId: "call-1", outputText: "src/index.ts" }],
		},
		{
			id: "assistant-final",
			role: "assistant",
			runId: "run-1",
			blocks: [{ id: "final-text", type: "text", text: "Found src/index.ts." }],
		},
	];
}

function runWithFinalReasoning(): Message[] {
	const messages = runWithoutIntermediateProse();
	const finalMessage = messages[messages.length - 1];
	finalMessage.blocks = [
		{ id: "final-reasoning", type: "reasoning", text: "Need to summarize the result." },
		...finalMessage.blocks,
	];
	return messages;
}

function runWithReasoningOnlyFinalReply(): Message[] {
	return [
		{
			id: "user-1",
			role: "user",
			runId: "run-reasoning-only",
			blocks: [{ id: "user-text", type: "text", text: "Explain" }],
		},
		{
			id: "assistant-final",
			role: "assistant",
			runId: "run-reasoning-only",
			blocks: [
				{ id: "final-reasoning", type: "reasoning", text: "Need a concise answer." },
				{ id: "final-text", type: "text", text: "Here is the answer." },
			],
		},
	];
}

function runWithFinalArtifact(): Message[] {
	return [
		{
			id: "user-1",
			role: "user",
			runId: "run-artifact",
			blocks: [{ id: "user-text", type: "text", text: "Create a file" }],
		},
		{
			id: "assistant-final",
			role: "assistant",
			runId: "run-artifact",
			blocks: [
				{ id: "final-reasoning", type: "reasoning", text: "Need to produce the artifact." },
				{
					id: "final-artifact",
					type: "artifact",
					artifactId: "artifact-1",
					mime: "text/plain",
					title: "notes.txt",
					content: "done",
				},
			],
		},
	];
}

function runWithTrailingWorkAfterFinalText(): Message[] {
	return [
		{
			id: "user-1",
			role: "user",
			runId: "run-trailing-work",
			blocks: [{ id: "user-text", type: "text", text: "Finish up" }],
		},
		{
			id: "assistant-final",
			role: "assistant",
			runId: "run-trailing-work",
			blocks: [
				{ id: "final-reasoning", type: "reasoning", text: "Need one last command." },
				{ id: "final-text", type: "text", text: "The answer is ready." },
				{
					id: "final-tool",
					type: "tool_call",
					toolCallId: "call-final",
					name: "notify",
					argsText: "{}",
					status: "complete",
				},
			],
		},
		{
			id: "tool-result",
			role: "tool",
			runId: "run-trailing-work",
			blocks: [{ id: "tool-result-block", type: "tool_result", toolCallId: "call-final", outputText: "ok" }],
		},
	];
}

function runWithOnlyToolResultNoise(): Message[] {
	return [
		{
			id: "user-1",
			role: "user",
			runId: "run-result-only",
			blocks: [{ id: "user-text", type: "text", text: "Continue" }],
		},
		{
			id: "tool-result",
			role: "tool",
			runId: "run-result-only",
			blocks: [{ id: "tool-result-block", type: "tool_result", toolCallId: "call-missing", outputText: "late result" }],
		},
		{
			id: "assistant-final",
			role: "assistant",
			runId: "run-result-only",
			blocks: [{ id: "final-text", type: "text", text: "Done." }],
		},
	];
}

function visibleText(item: RunItem): string[] {
	return item.segments
		.filter((segment) => segment.type === "messages")
		.flatMap((segment) => segment.messages)
		.flatMap((message) => message.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])));
}

function blockShape(item: RunItem) {
	return {
		steps: item.segments
			.filter((segment) => segment.type === "work")
			.flatMap((segment) => segment.messages)
			.map((message) => ({
				messageId: message.id,
				role: message.role,
				blocks: message.blocks.map((block) => block.type),
			})),
		visible: item.segments
			.filter((segment) => segment.type === "messages")
			.flatMap((segment) => segment.messages)
			.map((message) => ({
				messageId: message.id,
				role: message.role,
				blocks: message.blocks.map((block) => block.type),
			})),
	};
}

function segmentShape(item: RunItem) {
	return item.segments.map((segment) => ({
		type: segment.type,
		messages: segment.messages.map((message) => ({
			messageId: message.id,
			role: message.role,
			blocks: message.blocks.map((block) => block.type),
		})),
	}));
}

test("machinery collapse keeps intermediate assistant prose visible and folds machinery", () => {
	const item = onlyAgentRun(runWithIntermediateProse());

	assert.deepEqual(visibleText(item), [
		"Верно, playground/ - мое. Давай уберу это сейчас.",
		"Вот, теперь в memory/random-ideas.md.",
	]);
	assert.deepEqual(segmentShape(item), [
		{
			type: "messages",
			messages: [{ messageId: "assistant-135", role: "assistant", blocks: ["text"] }],
		},
		{
			type: "work",
			messages: [
				{ messageId: "assistant-135", role: "assistant", blocks: ["reasoning"] },
				{ messageId: "assistant-135", role: "assistant", blocks: ["tool_call"] },
				{ messageId: "assistant-137", role: "assistant", blocks: ["tool_call"] },
			],
		},
		{
			type: "messages",
			messages: [{ messageId: "assistant-139", role: "assistant", blocks: ["text"] }],
		},
	]);
});

test("full collapse folds intermediate prose along with tool work", () => {
	const item = onlyAgentRun(runWithIntermediateProse(), { agentRunCollapse: "full" });

	assert.deepEqual(visibleText(item), ["Вот, теперь в memory/random-ideas.md."]);
	assert.deepEqual(blockShape(item).steps, [
		{ messageId: "assistant-135", role: "assistant", blocks: ["reasoning", "text", "tool_call"] },
		{ messageId: "assistant-137", role: "assistant", blocks: ["tool_call"] },
	]);
});

test("final reasoning is folded instead of rendering with the final text", () => {
	const messages = runWithFinalReasoning();
	const machinery = onlyAgentRun(messages);
	const full = onlyAgentRun(messages, { agentRunCollapse: "full" });

	assert.deepEqual(blockShape(machinery).visible, [
		{ messageId: "assistant-final", role: "assistant", blocks: ["text"] },
	]);
	assert.deepEqual(blockShape(full).visible, [{ messageId: "assistant-final", role: "assistant", blocks: ["text"] }]);
	assert.deepEqual(blockShape(machinery).steps.at(-1), {
		messageId: "assistant-final",
		role: "assistant",
		blocks: ["reasoning"],
	});
	assert.deepEqual(blockShape(full).steps.at(-1), {
		messageId: "assistant-final",
		role: "assistant",
		blocks: ["reasoning"],
	});
});

test("reasoning-only final replies fold reasoning before the visible answer", () => {
	const item = onlyAgentRun(runWithReasoningOnlyFinalReply());

	assert.deepEqual(visibleText(item), ["Here is the answer."]);
	assert.deepEqual(segmentShape(item), [
		{
			type: "work",
			messages: [{ messageId: "assistant-final", role: "assistant", blocks: ["reasoning"] }],
		},
		{
			type: "messages",
			messages: [{ messageId: "assistant-final", role: "assistant", blocks: ["text"] }],
		},
	]);
});

test("final artifacts count as visible agent replies", () => {
	const item = onlyAgentRun(runWithFinalArtifact());

	assert.deepEqual(blockShape(item), {
		steps: [{ messageId: "assistant-final", role: "assistant", blocks: ["reasoning"] }],
		visible: [{ messageId: "assistant-final", role: "assistant", blocks: ["artifact"] }],
	});
});

test("machinery collapse tolerates trailing work after the last assistant prose", () => {
	const item = onlyAgentRun(runWithTrailingWorkAfterFinalText());

	assert.deepEqual(visibleText(item), ["The answer is ready."]);
	assert.deepEqual(segmentShape(item), [
		{
			type: "messages",
			messages: [{ messageId: "assistant-final", role: "assistant", blocks: ["text"] }],
		},
		{
			type: "work",
			messages: [
				{ messageId: "assistant-final", role: "assistant", blocks: ["reasoning"] },
				{ messageId: "assistant-final", role: "assistant", blocks: ["tool_call"] },
			],
		},
	]);
});

test("runs without intermediate prose render the same in full and machinery modes", () => {
	const messages = runWithoutIntermediateProse();
	const full = onlyAgentRun(messages, { agentRunCollapse: "full" });
	const machinery = onlyAgentRun(messages, { agentRunCollapse: "machinery" });

	assert.deepEqual(blockShape(machinery), blockShape(full));
});

test("standalone tool results do not trigger agent run collapse", () => {
	const items = buildFeedItems(runWithOnlyToolResultNoise(), {});

	assert.equal(items.length, 3);
	assert.equal(items.some(isAgentRunItem), false);
});

test("active machinery agent runs render as expanded work", () => {
	const messages = runWithoutIntermediateProse().slice(0, 3);
	const item = onlyAgentRun(messages, { streamingMessageIds: new Set(["assistant-tool"]) });

	assert.deepEqual(segmentShape(item), [
		{
			type: "work",
			messages: [{ messageId: "assistant-tool", role: "assistant", blocks: ["tool_call"] }],
		},
	]);
	assert.ok(item.segments.every((segment) => segment.type !== "work" || !segment.collapsed));
});
