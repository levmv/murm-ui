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

test("applyStreamEventToState appends text and reasoning deltas to the pending message", () => {
	const assistant: Message = {
		id: "assistant-1",
		role: "assistant",
		blocks: [],
		meta: { ephemeral: true, local: true },
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
	assert.deepEqual(state.messages[0].meta, { local: true });
});

test("applyStreamEventToState keeps pending messages ephemeral for empty deltas", () => {
	const assistant: Message = { id: "assistant-1", role: "assistant", blocks: [], meta: { ephemeral: true } };
	const state = stateWith([assistant]);

	applyStreamEventToState(state, assistant.id, {
		type: "reasoning_delta",
		messageId: assistant.id,
		blockId: "reasoning-1",
		delta: "",
		encrypted: true,
	});

	assert.equal(state.messages[0].meta?.ephemeral, true);
});

test("applyStreamEventToState preserves ephemeral during message_start metadata merge", () => {
	const assistant: Message = { id: "assistant-1", role: "assistant", blocks: [], meta: { ephemeral: true } };
	const state = stateWith([assistant]);

	applyStreamEventToState(state, assistant.id, {
		type: "message_start",
		message: {
			id: "provider-message",
			role: "assistant",
			blocks: [],
			meta: { ephemeral: false, providerMessage: true },
		},
	});

	assert.deepEqual(state.messages[0].meta, { ephemeral: true, providerMessage: true });
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

test("applyStreamEventToState records stream errors on state", () => {
	const assistant: Message = { id: "assistant-1", role: "assistant", blocks: [] };
	const state = stateWith([assistant]);

	applyStreamEventToState(state, assistant.id, {
		type: "error",
		message: "Provider failed",
		code: "provider_error",
	});

	assert.deepEqual(state.error, { message: "Provider failed", id: assistant.id });
});
