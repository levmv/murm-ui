import assert from "node:assert/strict";
import { test } from "node:test";
import { cloneMessages } from "./msg-utils";
import type { Message } from "./types";

test("cloneMessages clones usage metadata and nested details", () => {
	const messages: Message[] = [
		{
			id: "assistant-1",
			role: "assistant",
			blocks: [{ id: "text-1", type: "text", text: "hello" }],
			usage: {
				input: 10,
				output: 5,
				total: 15,
				cacheRead: 3,
				details: { provider: "test", nested: { values: [1, "two", true] } },
			},
		},
	];

	const cloned = cloneMessages(messages);

	assert.notEqual(cloned[0], messages[0]);
	assert.notEqual(cloned[0].blocks, messages[0].blocks);
	assert.notEqual(cloned[0].usage, messages[0].usage);
	assert.notEqual(cloned[0].usage?.details, messages[0].usage?.details);
	assert.deepEqual(cloned, messages);

	(cloned[0].usage?.details as { nested: { values: unknown[] } }).nested.values.push("changed");

	assert.deepEqual((messages[0].usage?.details as { nested: { values: unknown[] } }).nested.values, [1, "two", true]);
});
