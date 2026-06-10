import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSSE } from "./sse";

test("flushes a buffered TextDecoder sequence at stream end", async () => {
	const bytes = new TextEncoder().encode("data: hi ");
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const chunk = new Uint8Array(bytes.length + 1);
			chunk.set(bytes);
			chunk[chunk.length - 1] = 0xc3;
			controller.enqueue(chunk);
			controller.close();
		},
	});
	const messages: string[] = [];

	await parseSSE(new Response(stream), (data) => {
		messages.push(data);
		return undefined;
	});

	assert.deepEqual(messages, [`hi ${String.fromCharCode(0xfffd)}`]);
});

test("cancels the underlying connection when the message callback throws", async () => {
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("data: boom\n\n"));
			// Stream intentionally left open: only an explicit cancel can end it.
		},
		cancel() {
			cancelled = true;
		},
	});

	await assert.rejects(
		parseSSE(new Response(stream), () => {
			throw new Error("callback failure");
		}),
		/callback failure/,
	);

	assert.equal(cancelled, true);
});
