import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationModel } from "./conversation";
import type { ConversationChange, ConversationInvalidation } from "./conversation-types";
import type { ContentBlock, Message } from "./types";

function message(id: string, text = ""): Message {
	return { id, role: "assistant", status: "streaming", blocks: [{ id: "text", type: "text", text }] };
}

test("addressed batches interleave A/B/A and finish/error independently", () => {
	const model = new ConversationModel();
	model.setConversation({ id: "c", messages: [message("a"), message("b")] });
	model.apply({
		conversationId: "c",
		changes: [
			{ type: "text.append", messageId: "a", blockId: "text", delta: "A" },
			{ type: "text.append", messageId: "b", blockId: "text", delta: "B" },
			{ type: "text.append", messageId: "a", blockId: "text", delta: " again" },
			{ type: "message.state", messageId: "b", status: "error", error: "B failed" },
		],
	});
	assert.equal(model.state.messages[0].blocks[0].type === "text" && model.state.messages[0].blocks[0].text, "A again");
	assert.equal(model.state.messages[1].blocks[0].type === "text" && model.state.messages[1].blocks[0].text, "B");
	assert.deepEqual([...model.streamingMessageIds], ["a"]);
	assert.equal(model.state.messages[0].error, undefined);
	assert.equal(model.state.messages[1].error, "B failed");
	model.apply({
		conversationId: "c",
		changes: [
			{ type: "message.state", messageId: "b", error: "B disconnected" },
			{ type: "message.state", messageId: "b", usage: { input: 1, output: 2, total: 3 } },
		],
	});
	assert.equal(model.state.messages[1].status, "error");
	assert.equal(model.state.messages[1].error, "B disconnected");
	assert.equal(model.state.messages[1].usage?.total, 3);
	model.apply({
		conversationId: "c",
		changes: [{ type: "message.state", messageId: "a", status: "complete", usage: { input: 2, output: 3, total: 5 } }],
	});
	assert.equal(model.streamingMessageIds.size, 0);
	assert.equal(model.state.messages[0].usage?.total, 5);
});

test("invalid batch addresses apply nothing, while put then append is valid", () => {
	const model = new ConversationModel();
	model.setConversation({ id: "c", messages: [message("a", "original")] });
	assert.throws(
		() =>
			model.apply({
				conversationId: "c",
				changes: [
					{ type: "text.append", messageId: "a", blockId: "text", delta: " unwanted" },
					{ type: "text.append", messageId: "missing", blockId: "text", delta: "!" },
				],
			}),
		/Unknown message/,
	);
	assert.deepEqual(model.state.messages[0], message("a", "original"));
	model.apply({
		conversationId: "c",
		changes: [
			{ type: "message.put", message: message("b"), beforeId: "a" },
			{ type: "text.append", messageId: "b", blockId: "text", delta: "new" },
		],
	});
	assert.deepEqual(model.state.messages, [message("b", "new"), message("a", "original")]);
});

test("tool and encrypted reasoning deltas mutate only their addressed blocks and validate atomically", () => {
	const model = new ConversationModel();
	model.setConversation({
		id: "c",
		messages: [
			message("history"),
			{
				id: "a",
				role: "assistant",
				blocks: [
					{ id: "thought", type: "reasoning", text: "", encrypted: true },
					{ id: "tool", type: "tool_call", toolCallId: "call", name: "", argsText: "", status: "streaming" },
				],
			},
		],
	});
	const messages = model.state.messages;
	const [thought, tool] = messages[1].blocks;
	Object.defineProperty(messages[0], "blocks", {
		get() {
			throw new Error("History visited");
		},
	});
	const changes: ConversationChange[] = [
		{ type: "tool.update", messageId: "a", blockId: "tool", name: "read", argsDelta: "{}" },
		{ type: "text.append", messageId: "a", blockId: "thought", delta: "cipher", encrypted: true },
	];
	assert.throws(
		() =>
			model.apply({
				conversationId: "c",
				changes: [...changes, { type: "tool.update", messageId: "a", blockId: "thought", argsDelta: "invalid" }],
			}),
		/Invalid append target/,
	);
	assert.equal(tool.type === "tool_call" && tool.argsText, "");
	assert.equal(thought.type === "reasoning" && thought.encryptedText, undefined);
	model.apply({ conversationId: "c", changes });
	assert.equal(model.state.messages, messages);
	assert.equal(messages[1].blocks[0], thought);
	assert.equal(messages[1].blocks[1], tool);
	assert.equal(tool.type === "tool_call" && tool.argsText, "{}");
	assert.equal(thought.type === "reasoning" && thought.encryptedText, "cipher");
});

test("snapshot and patch data are copied; token deltas retain history/message/block identity", () => {
	const model = new ConversationModel();
	const input = [message("a", "first"), message("b", "second")];
	model.setConversation({ id: "c", messages: input });
	const messages = model.state.messages;
	const first = messages[0];
	const block = first.blocks[0];
	const changes: ConversationInvalidation[] = [];
	model.subscribe((change) => changes.push(change));
	model.apply({ conversationId: "c", changes: [{ type: "text.append", messageId: "a", blockId: "text", delta: "!" }] });
	assert.equal(model.state.messages, messages);
	assert.equal(model.state.messages[0], first);
	assert.equal(first.blocks[0], block);
	assert.equal(input[0].blocks[0].type === "text" && input[0].blocks[0].text, "first");
	assert.equal(changes[0].structural, false);
	assert.deepEqual([...changes[0].messageIds], ["a"]);
	const card: Message = {
		id: "card",
		role: "assistant",
		blocks: [{ id: "x", type: "custom", kind: "test", data: { nested: [1] }, fallbackText: "card" }],
	};
	model.apply({ conversationId: "c", changes: [{ type: "message.put", message: card }] });
	assert.notEqual(model.state.messages[2].blocks[0], card.blocks[0]);
	assert.notEqual(
		model.state.messages[2].blocks[0].type === "custom" && model.state.messages[2].blocks[0].data,
		card.blocks[0].type === "custom" && card.blocks[0].data,
	);
});

test("token and metadata updates do not read preceding blocks to rebuild an address index", () => {
	const model = new ConversationModel();
	model.setConversation({
		id: "c",
		messages: [
			{
				id: "a",
				role: "assistant",
				blocks: [
					{ id: "earlier", type: "text", text: "Earlier" },
					{ id: "tail", type: "text", text: "Streaming" },
				],
			},
		],
	});
	const earlier = model.state.messages[0].blocks[0];
	Object.defineProperty(earlier, "id", {
		get() {
			throw new Error("Unchanged block visited");
		},
	});
	model.apply({
		conversationId: "c",
		changes: [
			{ type: "text.append", messageId: "a", blockId: "tail", delta: " one" },
			{ type: "text.append", messageId: "a", blockId: "tail", delta: " two" },
			{ type: "message.state", messageId: "a", usage: { input: 1, output: 2, total: 3 } },
		],
	});
	assert.deepEqual(model.state.messages[0].blocks[1], { id: "tail", type: "text", text: "Streaming one two" });
	assert.equal(model.state.messages[0].usage?.total, 3);
});

test("older history cannot overwrite live messages or leak across conversations", () => {
	const model = new ConversationModel();
	model.setConversation({ id: "b", messages: [message("current", "fresh")] });
	assert.equal(
		model.apply({ conversationId: "a", changes: [{ type: "message.put", message: message("wrong") }] }),
		false,
	);
	assert.equal(model.prepend("a", [message("wrong")]), false);
	model.prepend("b", [message("old"), message("current", "stale")]);
	assert.deepEqual(model.state.messages, [message("old"), message("current", "fresh")]);
	assert.throws(
		() => model.setConversation({ id: "b", messages: [message("duplicate"), message("duplicate")] }),
		/Duplicate/,
	);
	assert.equal(model.state.messages.length, 2);
});

test("card/tool replacements update locally and do not scan other messages or clone their metadata", () => {
	const model = new ConversationModel();
	const card: ContentBlock = { id: "card", type: "custom", kind: "form", data: { value: [1] }, fallbackText: "old" };
	const tool: ContentBlock = {
		id: "call",
		type: "tool_call",
		toolCallId: "call",
		name: "read",
		argsText: "{}",
		summary: "old summary",
		status: "running",
	};
	model.setConversation({
		id: "c",
		messages: [message("history"), { id: "target", role: "assistant", blocks: [card, tool] }],
	});
	const messages = model.state.messages;
	const historyBlocks = messages[0].blocks;
	let historyReads = 0;
	let metadataReads = 0;
	Object.defineProperty(messages[0], "blocks", {
		get() {
			historyReads++;
			return historyBlocks;
		},
	});
	Object.defineProperty(messages[1], "meta", {
		get() {
			metadataReads++;
			return { largePayload: "keep in place" };
		},
	});
	const oldCard = messages[1].blocks[0];
	const changes: ConversationInvalidation[] = [];
	model.subscribe((change) => changes.push(change));
	const updatedCard = { ...card, data: { value: [2] }, fallbackText: "new" };
	const { summary: _summary, ...updatedTool } = tool;
	model.apply({
		conversationId: "c",
		changes: [
			{ type: "block.put", messageId: "target", block: updatedCard },
			{ type: "block.put", messageId: "target", block: { ...updatedTool, argsText: '{"path":"a.txt"}' } },
		],
	});
	assert.equal(model.state.messages, messages);
	assert.equal(messages[1].blocks[0], oldCard);
	assert.deepEqual(oldCard, updatedCard);
	assert.equal("summary" in messages[1].blocks[1], false);
	assert.deepEqual([...changes[0].messageIds], ["target"]);
	assert.equal(changes[0].structural, false);
	updatedCard.data.value.push(3);
	assert.deepEqual(oldCard.type === "custom" && oldCard.data, { value: [2] });
	model.apply({
		conversationId: "c",
		changes: [
			{ type: "message.state", messageId: "target", status: "complete", usage: { input: 1, output: 2, total: 3 } },
		],
	});
	assert.equal(historyReads, 0);
	assert.equal(metadataReads, 0);
});

test("overlapping older pages retain transcript identity; no-op updates do not notify", () => {
	const model = new ConversationModel();
	model.setConversation({ id: "c", messages: [message("a", "fresh")] });
	const messages = model.state.messages;
	const changes: ConversationInvalidation[] = [];
	model.subscribe((change) => changes.push(change));
	model.prepend("c", [message("a", "stale")]);
	assert.equal(model.state.messages, messages);
	model.apply({ conversationId: "c", changes: [] });
	model.apply({
		conversationId: "c",
		changes: [
			{ type: "block.remove", messageId: "a", blockId: "missing" },
			{ type: "text.append", messageId: "a", blockId: "text", delta: "" },
		],
	});
	assert.equal(changes.length, 0);
});
