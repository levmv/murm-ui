import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ChatRequest, Message, RequestOptions, StreamEvent } from "../types";
import { OpenAIProvider } from "./openai";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function sse(...payloads: string[]): Response {
	return new Response(payloads.map((payload) => `data: ${payload}\n\n`).join(""));
}

function mockFetch(response: Response): { calls: { url: string; init: RequestInit }[] } {
	const calls: { url: string; init: RequestInit }[] = [];

	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), init: init ?? {} });
		return response;
	}) as typeof fetch;

	return { calls };
}

function textMessage(id: string, role: "system" | "user" | "assistant", text: string): Message {
	return {
		id,
		role,
		blocks: [{ id: `${id}-text`, type: "text", text }],
	};
}

function findEvent<T extends StreamEvent["type"]>(events: StreamEvent[], type: T): Extract<StreamEvent, { type: T }> {
	const event = events.find((candidate) => candidate.type === type);
	assert.ok(event, `Expected ${type} event`);
	return event as Extract<StreamEvent, { type: T }>;
}

function chatRequest(
	messages: Message[],
	options: RequestOptions = {},
	signal: AbortSignal = new AbortController().signal,
	extra: Partial<Pick<ChatRequest, "instructions" | "tools">> = {},
): ChatRequest {
	return { messages, options, signal, ...extra };
}

function titleRequest(
	messages: Message[],
	options: RequestOptions = {},
	signal: AbortSignal = new AbortController().signal,
	instructions?: string,
): ChatRequest {
	return { messages, options, signal, instructions };
}

test("streamChat parses text, reasoning, tool calls, usage, and finish events", async () => {
	const provider = new OpenAIProvider("test-key", "https://example.test/chat", "fallback-model");
	const reasoningChunk = JSON.stringify({
		id: "provider-message",
		choices: [{ delta: { reasoning_content: "thinking" } }],
	});
	const textChunk = JSON.stringify({
		choices: [{ delta: { content: "hello" } }],
	});
	const toolStartChunk = JSON.stringify({
		choices: [
			{
				delta: {
					tool_calls: [
						{
							index: 0,
							id: "call-1",
							function: { name: "lookup", arguments: '{"q"' },
						},
					],
				},
			},
		],
	});
	const toolDeltaChunk = JSON.stringify({
		choices: [
			{ delta: { tool_calls: [{ index: 0, function: { name: "lookup_weather", arguments: ':"weather"}' } }] } },
		],
	});
	const usageChunk = JSON.stringify({
		usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 3 } },
	});
	const finishChunk = JSON.stringify({
		choices: [{ delta: {}, finish_reason: "tool_calls" }],
	});
	const { calls } = mockFetch(sse(reasoningChunk, textChunk, toolStartChunk, toolDeltaChunk, usageChunk, finishChunk));
	const events: StreamEvent[] = [];

	await provider.streamChat(chatRequest([textMessage("user-1", "user", "hello")], { model: "chosen-model" }), (event) =>
		events.push(event),
	);

	assert.equal(calls[0].url, "https://example.test/chat");
	assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer test-key");

	const body = JSON.parse(calls[0].init.body as string);
	assert.equal(body.model, "chosen-model");
	assert.equal(body.stream, true);
	assert.equal(body.stream_options.include_usage, true);

	const start = findEvent(events, "message_start");
	assert.equal(start.message.id, "provider-message");

	const reasoning = findEvent(events, "reasoning_delta");
	assert.equal(reasoning.delta, "thinking");
	assert.equal(reasoning.encrypted, false);

	const text = findEvent(events, "text_delta");
	assert.equal(text.delta, "hello");

	const toolStart = findEvent(events, "tool_call_start");
	assert.equal(toolStart.block.toolCallId, "call-1");
	assert.equal(toolStart.block.name, "lookup");
	assert.equal(toolStart.block.argsText, '{"q"');

	const toolDelta = findEvent(events, "tool_call_delta");
	assert.equal(toolDelta.name, "lookup_weather");
	assert.equal(toolDelta.argsDelta, ':"weather"}');

	assert.deepEqual(findEvent(events, "usage"), { type: "usage", input: 10, output: 4, total: 14, cacheRead: 3 });
	assert.deepEqual(events.at(-1), { type: "finish", reason: "tool_use" });
});

test("streamChat omits Authorization when the API key is empty", async () => {
	const provider = new OpenAIProvider("   ", "https://example.test/chat", "fallback-model");
	const finishChunk = JSON.stringify({
		choices: [{ delta: {}, finish_reason: "stop" }],
	});
	const { calls } = mockFetch(sse(finishChunk));

	await provider.streamChat(chatRequest([textMessage("user-1", "user", "hello")]), () => {});

	assert.deepEqual(calls[0].init.headers, { "Content-Type": "application/json" });
});

test("streamChat marks encrypted reasoning without retaining provider payloads", async () => {
	const provider = new OpenAIProvider("test-key", "https://example.test/chat", "fallback-model");
	const encryptedObjectChunk = JSON.stringify({
		id: "provider-message",
		choices: [{ delta: { reasoning: { encrypted: "cipher-object" } } }],
	});
	const encryptedFieldChunk = JSON.stringify({
		choices: [{ delta: { reasoning_encrypted: "cipher-field" } }],
	});
	mockFetch(sse(encryptedObjectChunk, encryptedFieldChunk, "[DONE]"));
	const events: StreamEvent[] = [];

	await provider.streamChat(chatRequest([textMessage("user-1", "user", "hello")]), (event) => events.push(event));

	const reasoningEvents = events.filter(
		(event): event is Extract<StreamEvent, { type: "reasoning_delta" }> => event.type === "reasoning_delta",
	);
	assert.equal(reasoningEvents.length, 2);
	assert.deepEqual(
		reasoningEvents.map(({ delta, encrypted }) => ({ delta, encrypted })),
		[
			{ delta: "", encrypted: true },
			{ delta: "", encrypted: true },
		],
	);
});

test("streamChat formats mixed message blocks for OpenAI-compatible requests", async () => {
	const provider = new OpenAIProvider("test-key", "https://example.test/chat", "fallback-model");
	const { calls } = mockFetch(sse("[DONE]"));
	const messages: Message[] = [
		textMessage("system-1", "system", "be concise"),
		{
			id: "user-1",
			role: "user",
			blocks: [
				{ id: "user-text", type: "text", text: "describe this" },
				{ id: "image", type: "file", mimeType: "image/png", name: "image.png", data: "data:image/png;base64,abc" },
				{ id: "file", type: "file", mimeType: "text/plain", name: "notes.txt", data: "notes" },
			],
		},
		{
			id: "assistant-1",
			role: "assistant",
			blocks: [
				{ id: "assistant-text", type: "text", text: "I will call a tool" },
				{ id: "reasoning", type: "reasoning", text: "hidden" },
				{ id: "artifact", type: "artifact", artifactId: "artifact-1", mime: "text/plain", content: "artifact" },
				{
					id: "tool-call",
					type: "tool_call",
					toolCallId: "call-1",
					name: "lookup",
					argsText: '{"q":"weather"}',
					status: "complete",
				},
			],
		},
		{
			id: "tool-1",
			role: "tool",
			blocks: [{ id: "tool-result", type: "tool_result", toolCallId: "call-1", outputText: "sunny" }],
		},
	];
	const options: RequestOptions = {
		messages: "custom messages passthrough",
		providerFlag: "custom passthrough",
		stream: false,
		temperature: 0.4,
		stream_options: { extra: true },
	};

	await provider.streamChat(
		chatRequest(messages, options, new AbortController().signal, {
			instructions: "Follow request instructions.",
			tools: [{ type: "function", function: { name: "lookup" } }],
		}),
		() => {},
	);

	const body = JSON.parse(calls[0].init.body as string);
	assert.notEqual(body.messages, "custom messages passthrough");
	assert.equal(body.stream, true);
	assert.equal(body.providerFlag, "custom passthrough");
	assert.equal(body.temperature, 0.4);
	assert.deepEqual(body.tools, [{ type: "function", function: { name: "lookup" } }]);
	assert.deepEqual(body.stream_options, { include_usage: true, extra: true });

	assert.deepEqual(body.messages[0], { role: "system", content: "Follow request instructions." });
	assert.equal(body.messages[1].content, "be concise");
	assert.deepEqual(body.messages[2].content, [
		{ type: "text", text: "describe this" },
		{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
		{ type: "text", text: "\n\n--- File: notes.txt ---\nnotes" },
	]);
	assert.equal(body.messages[3].content, "I will call a tool");
	assert.deepEqual(body.messages[3].tool_calls, [
		{
			id: "call-1",
			type: "function",
			function: { name: "lookup", arguments: '{"q":"weather"}' },
		},
	]);
	assert.deepEqual(body.messages[4], { role: "tool", tool_call_id: "call-1", content: "sunny" });
});

test("streamChat omits incomplete tool calls from OpenAI-compatible requests", async () => {
	const provider = new OpenAIProvider("test-key", "https://example.test/chat", "fallback-model");
	const { calls } = mockFetch(sse("[DONE]"));
	const messages: Message[] = [
		textMessage("user-1", "user", "hello"),
		{
			id: "assistant-error-only",
			role: "assistant",
			blocks: [
				{
					id: "tool-error-only",
					type: "tool_call",
					toolCallId: "call-error-only",
					name: "lookup",
					argsText: '{"q":"bad"}',
					status: "error",
				},
			],
		},
		{
			id: "assistant-text-error",
			role: "assistant",
			blocks: [
				{ id: "assistant-text", type: "text", text: "Partial answer" },
				{
					id: "tool-error",
					type: "tool_call",
					toolCallId: "call-error",
					name: "lookup",
					argsText: '{"q":"bad"}',
					status: "error",
				},
			],
		},
		{
			id: "tool-error-result",
			role: "tool",
			blocks: [{ id: "tool-error-result-block", type: "tool_result", toolCallId: "call-error", outputText: "bad" }],
		},
		{
			id: "assistant-complete",
			role: "assistant",
			blocks: [
				{
					id: "tool-complete",
					type: "tool_call",
					toolCallId: "call-complete",
					name: "lookup",
					argsText: '{"q":"ok"}',
					status: "complete",
				},
			],
		},
		{
			id: "tool-complete-result",
			role: "tool",
			blocks: [
				{ id: "tool-complete-result-block", type: "tool_result", toolCallId: "call-complete", outputText: "ok" },
			],
		},
	];

	await provider.streamChat(chatRequest(messages), () => {});

	const body = JSON.parse(calls[0].init.body as string);
	assert.deepEqual(body.messages, [
		{ role: "user", content: "hello" },
		{ role: "assistant", content: "Partial answer" },
		{
			role: "assistant",
			tool_calls: [
				{
					id: "call-complete",
					type: "function",
					function: { name: "lookup", arguments: '{"q":"ok"}' },
				},
			],
			content: null,
		},
		{ role: "tool", tool_call_id: "call-complete", content: "ok" },
	]);
});

test("streamChat rejects for non-OK API responses", async () => {
	const provider = new OpenAIProvider("test-key", "https://example.test/chat", "fallback-model");
	mockFetch(new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }));
	const events: StreamEvent[] = [];

	await assert.rejects(
		provider.streamChat(chatRequest([textMessage("user-1", "user", "hello")]), (event) => events.push(event)),
		/API Error 401: bad key/,
	);

	assert.deepEqual(events, []);
});

test("streamChat rejects without events when fetch is aborted", async () => {
	const provider = new OpenAIProvider("test-key", "https://example.test/chat", "fallback-model");
	const controller = new AbortController();
	controller.abort();
	globalThis.fetch = (async () => {
		throw new DOMException("The operation was aborted.", "AbortError");
	}) as typeof fetch;
	const events: StreamEvent[] = [];

	await assert.rejects(
		provider.streamChat(chatRequest([textMessage("user-1", "user", "hello")], {}, controller.signal), (event) =>
			events.push(event),
		),
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);

	assert.deepEqual(events, []);
});

test("generateTitle sends non-streaming title request options", async () => {
	const provider = new OpenAIProvider("test-key", "https://example.test/chat", "fallback-model");
	const { calls } = mockFetch(new Response(JSON.stringify({ choices: [{ message: { content: "Useful Title" } }] })));

	const title = await provider.generateTitle(
		titleRequest(
			[textMessage("user-1", "user", "hello"), textMessage("assistant-1", "assistant", "hello back")],
			{
				model: "title-model",
				temperature: 0.2,
				max_tokens: 8,
				messages: "custom messages passthrough",
				providerFlag: "custom title passthrough",
				stream: true,
				stream_options: { include_usage: true },
			},
			new AbortController().signal,
			"Name chats plainly.",
		),
	);

	assert.equal(title, "Useful Title");
	const body = JSON.parse(calls[0].init.body as string);
	assert.equal(body.model, "title-model");
	assert.equal(body.temperature, 0.2);
	assert.equal(body.max_tokens, 8);
	assert.equal(body.stream, false);
	assert.equal(body.stream_options, undefined);
	assert.equal(body.providerFlag, "custom title passthrough");
	assert.notEqual(body.messages, "custom messages passthrough");
	assert.deepEqual(body.messages[0], { role: "system", content: "Name chats plainly." });
	assert.equal(body.messages.at(-1).role, "user");
	assert.match(body.messages.at(-1).content, /Summarize the above conversation/);
});

test("generateTitle omits Authorization when the API key is empty", async () => {
	const provider = new OpenAIProvider("", "https://example.test/chat", "fallback-model");
	const { calls } = mockFetch(new Response(JSON.stringify({ choices: [{ message: { content: "Useful Title" } }] })));

	const title = await provider.generateTitle(
		titleRequest([textMessage("user-1", "user", "hello"), textMessage("assistant-1", "assistant", "hello back")]),
	);

	assert.equal(title, "Useful Title");
	assert.deepEqual(calls[0].init.headers, { "Content-Type": "application/json" });
});

test("generateTitle uses a default title system prompt", async () => {
	const provider = new OpenAIProvider("test-key", "https://example.test/chat", "fallback-model");
	const { calls } = mockFetch(new Response(JSON.stringify({ choices: [{ message: { content: "Useful Title" } }] })));

	await provider.generateTitle(
		titleRequest(
			[textMessage("user-1", "user", "hello"), textMessage("assistant-1", "assistant", "hello back")],
			{ model: "title-model" },
			new AbortController().signal,
		),
	);

	const body = JSON.parse(calls[0].init.body as string);
	assert.deepEqual(body.messages[0], {
		role: "system",
		content: "You generate concise chat titles. Reply only with the title, without quotes or extra text.",
	});
});
