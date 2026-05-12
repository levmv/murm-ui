import assert from "node:assert/strict";
import { test } from "node:test";
import { applyStreamEventToState } from "./stream-reducer";
import type { ChatState, ContentBlock, Message } from "./types";

function stateWith(messages: Message[]): ChatState {
	return {
		sessions: [],
		hasMoreSessions: false,
		currentSessionId: "chat-1",
		messages,
		generatingMessageId: null,
		isLoadingSession: false,
		isLoadingSessions: false,
		error: null,
	};
}

function getText(message: Message): string {
	return message.blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n\n");
}

test("applyStreamEventToState appends text and reasoning deltas to the pending message", () => {
	const assistant: Message = {
		id: "assistant-1",
		role: "assistant",
		blocks: [],
		ephemeral: true,
		meta: { local: true },
	};
	const state = stateWith([assistant]);

	applyStreamEventToState(state, assistant.id, {
		type: "text_delta",
		messageId: assistant.id,
		blockId: "text-1",
		delta: "hel",
	});
	applyStreamEventToState(state, assistant.id, {
		type: "text_delta",
		messageId: assistant.id,
		blockId: "text-1",
		delta: "lo",
	});
	applyStreamEventToState(state, assistant.id, {
		type: "reasoning_delta",
		messageId: assistant.id,
		blockId: "reasoning-1",
		delta: "hidden",
		encrypted: true,
	});

	assert.deepEqual(state.messages[0].blocks, [
		{ id: "text-1", type: "text", text: "hello" },
		{
			id: "reasoning-1",
			type: "reasoning",
			text: "",
			encrypted: true,
			encryptedText: "hidden",
		},
	]);
	assert.equal(state.messages[0].ephemeral, undefined);
	assert.deepEqual(state.messages[0].meta, { local: true });
});

test("applyStreamEventToState keeps pending messages ephemeral for empty deltas", () => {
	const assistant: Message = { id: "assistant-1", role: "assistant", blocks: [], ephemeral: true };
	const state = stateWith([assistant]);

	applyStreamEventToState(state, assistant.id, {
		type: "reasoning_delta",
		messageId: assistant.id,
		blockId: "reasoning-1",
		delta: "",
		encrypted: true,
	});

	assert.equal(state.messages[0].ephemeral, true);
});

test("applyStreamEventToState adopts provider message ids during message_start", () => {
	const assistant: Message = { id: "assistant-1", role: "assistant", blocks: [], ephemeral: true };
	const state = stateWith([assistant]);
	state.generatingMessageId = assistant.id;

	const currentMessageId = applyStreamEventToState(state, assistant.id, {
		type: "message_start",
		message: {
			id: "provider-message",
			role: "assistant",
			blocks: [],
			meta: { providerMessage: true },
		},
	});

	assert.equal(currentMessageId, "provider-message");
	assert.equal(state.messages[0].id, "provider-message");
	assert.equal(state.generatingMessageId, "provider-message");
	assert.equal(state.messages[0].ephemeral, true);
	assert.deepEqual(state.messages[0].meta, { providerMessage: true });
});

test("applyStreamEventToState adopts provider message ids from first delta when message_start is omitted", () => {
	const assistant: Message = { id: "assistant-1", role: "assistant", blocks: [], ephemeral: true };
	const state = stateWith([assistant]);
	state.generatingMessageId = assistant.id;

	const currentMessageId = applyStreamEventToState(state, assistant.id, {
		type: "text_delta",
		messageId: "provider-message",
		blockId: "text-1",
		delta: "hello",
	});

	assert.equal(currentMessageId, "provider-message");
	assert.equal(state.messages[0].id, "provider-message");
	assert.equal(state.generatingMessageId, "provider-message");
	assert.equal(getText(state.messages[0]), "hello");
	assert.equal(state.messages[0].ephemeral, undefined);
});

test("applyStreamEventToState starts another assistant message from a later message_start", () => {
	const assistant: Message = { id: "assistant-1", role: "assistant", blocks: [], ephemeral: true };
	const state = stateWith([assistant]);
	state.generatingMessageId = assistant.id;

	let currentMessageId = applyStreamEventToState(state, assistant.id, {
		type: "message_start",
		message: { id: "provider-message-1", role: "assistant", blocks: [] },
	});
	currentMessageId = applyStreamEventToState(state, currentMessageId, {
		type: "text_delta",
		messageId: "provider-message-1",
		blockId: "text-1",
		delta: "first",
	});
	currentMessageId = applyStreamEventToState(state, currentMessageId, {
		type: "tool_call_start",
		messageId: "provider-message-1",
		block: {
			id: "tool-1",
			type: "tool_call",
			toolCallId: "call-1",
			name: "lookup",
			argsText: "{}",
			status: "streaming",
		},
	});
	currentMessageId = applyStreamEventToState(state, currentMessageId, {
		type: "message_start",
		message: { id: "provider-message-2", role: "assistant", blocks: [] },
	});
	currentMessageId = applyStreamEventToState(state, currentMessageId, {
		type: "text_delta",
		messageId: "provider-message-2",
		blockId: "text-2",
		delta: "second",
	});

	assert.equal(currentMessageId, "provider-message-2");
	assert.equal(state.messages.length, 2);
	assert.equal(state.messages[0].id, "provider-message-1");
	assert.equal(getText(state.messages[0]), "first");
	assert.equal((state.messages[0].blocks[1] as Extract<ContentBlock, { type: "tool_call" }>).status, "complete");
	assert.equal(state.messages[1].id, "provider-message-2");
	assert.equal(getText(state.messages[1]), "second");
	assert.equal(state.generatingMessageId, "provider-message-2");
});

test("applyStreamEventToState starts another assistant message from a later delta without message_start", () => {
	const assistant: Message = { id: "assistant-1", role: "assistant", blocks: [], ephemeral: true };
	const state = stateWith([assistant]);
	state.generatingMessageId = assistant.id;

	let currentMessageId = applyStreamEventToState(state, assistant.id, {
		type: "text_delta",
		messageId: "provider-message-1",
		blockId: "text-1",
		delta: "first",
	});
	currentMessageId = applyStreamEventToState(state, currentMessageId, {
		type: "text_delta",
		messageId: "provider-message-2",
		blockId: "text-2",
		delta: "second",
	});

	assert.equal(currentMessageId, "provider-message-2");
	assert.equal(state.messages.length, 2);
	assert.equal(getText(state.messages[0]), "first");
	assert.equal(getText(state.messages[1]), "second");
});

test("applyStreamEventToState keeps the active message id when a provider id collides with history", () => {
	const oldAssistant: Message = {
		id: "provider-message",
		role: "assistant",
		blocks: [{ id: "old-text", type: "text", text: "old" }],
	};
	const assistant: Message = { id: "assistant-1", role: "assistant", blocks: [], ephemeral: true };
	const state = stateWith([oldAssistant, assistant]);
	state.generatingMessageId = assistant.id;

	const currentMessageId = applyStreamEventToState(state, assistant.id, {
		type: "text_delta",
		messageId: "provider-message",
		blockId: "text-1",
		delta: "new",
	});

	assert.equal(currentMessageId, "assistant-1");
	assert.equal(getText(state.messages[0]), "old");
	assert.equal(getText(state.messages[1]), "new");
});

test("applyStreamEventToState stores usage metadata without clearing ephemeral state", () => {
	const assistant: Message = {
		id: "assistant-1",
		role: "assistant",
		blocks: [],
		ephemeral: true,
		meta: { local: true },
	};
	const state = stateWith([assistant]);

	applyStreamEventToState(state, assistant.id, {
		type: "usage",
		input: 10,
		output: 4,
		cacheRead: 3,
		cacheWrite: 2,
		details: { provider: "test" },
	});

	assert.equal(state.messages[0].ephemeral, true);
	assert.deepEqual(state.messages[0].meta, { local: true });
	assert.deepEqual(state.messages[0].usage, {
		input: 10,
		output: 4,
		total: 14,
		cacheRead: 3,
		cacheWrite: 2,
		details: { provider: "test" },
	});
});

test("applyStreamEventToState updates tool calls and finalizes streaming statuses", () => {
	const assistant: Message = { id: "assistant-1", role: "assistant", blocks: [] };
	const state = stateWith([assistant]);

	applyStreamEventToState(state, assistant.id, {
		type: "tool_call_start",
		messageId: assistant.id,
		block: {
			id: "tool-1",
			type: "tool_call",
			toolCallId: "call-1",
			name: "",
			argsText: "",
			status: "streaming",
		},
	});
	applyStreamEventToState(state, assistant.id, {
		type: "tool_call_delta",
		messageId: assistant.id,
		blockId: "tool-1",
		name: "search",
		argsDelta: '{"q":"docs"}',
	});
	applyStreamEventToState(state, assistant.id, { type: "finish", reason: "stop" });

	const toolCall = state.messages[0].blocks[0] as Extract<ContentBlock, { type: "tool_call" }>;
	assert.equal(toolCall.name, "search");
	assert.equal(toolCall.argsText, '{"q":"docs"}');
	assert.equal(toolCall.status, "complete");
});

test("applyStreamEventToState records stream errors and finalizes streaming tool calls", () => {
	const assistant: Message = {
		id: "assistant-1",
		role: "assistant",
		blocks: [
			{
				id: "tool-streaming",
				type: "tool_call",
				toolCallId: "call-streaming",
				name: "lookup",
				argsText: "{}",
				status: "streaming",
			},
			{
				id: "tool-pending",
				type: "tool_call",
				toolCallId: "call-pending",
				name: "queued",
				argsText: "{}",
				status: "pending",
			},
			{
				id: "tool-complete",
				type: "tool_call",
				toolCallId: "call-complete",
				name: "done",
				argsText: "{}",
				status: "complete",
			},
		],
	};
	const state = stateWith([assistant]);

	applyStreamEventToState(state, assistant.id, {
		type: "error",
		message: "Provider failed",
	});

	assert.deepEqual(state.error, { message: "Provider failed", id: assistant.id });
	assert.deepEqual(
		state.messages[0].blocks.map((block) => (block.type === "tool_call" ? block.status : null)),
		["error", "pending", "complete"],
	);
});
