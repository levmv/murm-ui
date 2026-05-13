import assert from "node:assert/strict";
import { test } from "node:test";
import { cloneMessages } from "./msg-utils";
import type { Message } from "./types";

test("cloneMessages clones message metadata and nested usage details", () => {
	const messages: Message[] = [
		{
			id: "assistant-1",
			role: "assistant",
			blocks: [{ id: "text-1", type: "text", text: "hello" }],
			meta: { provider: { responseId: "resp-1", flags: ["cached"] } },
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
	assert.notEqual(cloned[0].meta, messages[0].meta);
	assert.notEqual(cloned[0].meta?.provider, messages[0].meta?.provider);
	assert.notEqual(cloned[0].usage, messages[0].usage);
	assert.notEqual(cloned[0].usage?.details, messages[0].usage?.details);
	assert.deepEqual(cloned, messages);

	(cloned[0].meta?.provider as { flags: unknown[] }).flags.push("changed");
	(cloned[0].usage?.details as { nested: { values: unknown[] } }).nested.values.push("changed");

	assert.deepEqual((messages[0].meta?.provider as { flags: unknown[] }).flags, ["cached"]);
	assert.deepEqual((messages[0].usage?.details as { nested: { values: unknown[] } }).nested.values, [1, "two", true]);
});
