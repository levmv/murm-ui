import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ChatSession } from "../types";
import { RemoteStorage } from "./remote";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function mockJsonFetch(payload: unknown, init?: ResponseInit): { calls: { url: string; init: RequestInit }[] } {
	const calls: { url: string; init: RequestInit }[] = [];

	globalThis.fetch = (async (input: string | URL | Request, requestInit?: RequestInit) => {
		calls.push({ url: String(input), init: requestInit ?? {} });
		return Response.json(payload, init);
	}) as typeof fetch;

	return { calls };
}

function session(): ChatSession {
	return {
		id: "chat-1",
		title: "A chat",
		updatedAt: 123,
		messages: [{ id: "msg-1", role: "user", blocks: [{ id: "text-1", type: "text", text: "hello" }] }],
	};
}

function sessionWithMessages(count: number): ChatSession {
	return {
		...session(),
		messages: Array.from({ length: count }, (_, index) => ({
			id: `msg-${index + 1}`,
			role: "user",
			blocks: [{ id: `text-${index + 1}`, type: "text", text: `message ${index + 1}` }],
		})),
	};
}

test("loadSessions sends pagination params and auth header", async () => {
	const { calls } = mockJsonFetch({ items: [], hasMore: false });
	const storage = new RemoteStorage("https://example.test", () => "token-1");

	const result = await storage.loadSessions(20, { updatedAt: 123, id: "chat-1" });

	assert.deepEqual(result, { items: [], hasMore: false });
	const url = new URL(calls[0].url);
	assert.equal(url.origin, "https://example.test");
	assert.equal(url.pathname, "/api/chats");
	assert.equal(url.searchParams.get("limit"), "20");
	assert.equal(url.searchParams.get("cursor"), "123");
	assert.equal(url.searchParams.get("cursorId"), "chat-1");
	assert.deepEqual(calls[0].init.headers, {
		"Content-Type": "application/json",
		Authorization: "Bearer token-1",
	});
});

test("supports empty and relative base URLs", async () => {
	const { calls } = mockJsonFetch({ items: [], hasMore: false });

	await new RemoteStorage("", () => null).loadSessions(5);
	await new RemoteStorage("/storage", () => null).loadSessions(5);
	await new RemoteStorage("storage", () => null).loadSessions(5);

	assert.equal(calls[0].url, "/api/chats?limit=5");
	assert.equal(calls[1].url, "/storage/api/chats?limit=5");
	assert.equal(calls[2].url, "storage/api/chats?limit=5");
});

test("requests omit Authorization when no token is available", async () => {
	const { calls } = mockJsonFetch({ items: [], hasMore: false });
	const storage = new RemoteStorage("https://example.test", () => null);

	await storage.loadSessions(10);

	assert.deepEqual(calls[0].init.headers, { "Content-Type": "application/json" });
});

test("loadOne returns null for missing chats and throws on other failures", async () => {
	const storage = new RemoteStorage("https://example.test", () => null);

	globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
	assert.equal(await storage.loadOne("missing"), null);

	globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
	await assert.rejects(() => storage.loadOne("broken"), /Failed to load chat/);
});

test("save, updateMetadata, and delete use the expected endpoints and methods", async () => {
	const { calls } = mockJsonFetch({ success: true });
	const storage = new RemoteStorage("https://example.test", () => "token-1");
	const chat = session();

	await storage.save(chat);
	await storage.updateMetadata(chat.id, { title: "Renamed" });
	await storage.delete(chat.id);

	assert.equal(calls[0].url, "https://example.test/api/chats/chat-1");
	assert.equal(calls[0].init.method, "PUT");
	assert.deepEqual(JSON.parse(calls[0].init.body as string), chat);
	assert.equal((calls[0].init.headers as Record<string, string>)["X-Murm-Save-Mode"], undefined);

	assert.equal(calls[1].url, "https://example.test/api/chats/chat-1/meta");
	assert.equal(calls[1].init.method, "POST");
	assert.deepEqual(JSON.parse(calls[1].init.body as string), { title: "Renamed" });

	assert.equal(calls[2].url, "https://example.test/api/chats/chat-1");
	assert.equal(calls[2].init.method, "DELETE");
});

test("saveLimit sends only the latest messages with a partial save header", async () => {
	const { calls } = mockJsonFetch({ success: true });
	const storage = new RemoteStorage("https://example.test", () => "token-1", { saveLimit: 2 });
	const chat = sessionWithMessages(4);

	await storage.save(chat);

	assert.equal(calls[0].init.method, "PUT");
	assert.deepEqual(
		JSON.parse(calls[0].init.body as string).messages.map((message: { id: string }) => message.id),
		["msg-3", "msg-4"],
	);
	assert.deepEqual(calls[0].init.headers, {
		"Content-Type": "application/json",
		Authorization: "Bearer token-1",
		"X-Murm-Save-Mode": "partial",
	});
});

test("saveLimit does not slice or add partial header when the session is within the limit", async () => {
	const { calls } = mockJsonFetch({ success: true });
	const storage = new RemoteStorage("https://example.test", () => null, { saveLimit: 2 });
	const chat = sessionWithMessages(2);

	await storage.save(chat);

	assert.deepEqual(JSON.parse(calls[0].init.body as string), chat);
	assert.deepEqual(calls[0].init.headers, { "Content-Type": "application/json" });
});

test("invalid saveLimit values are disabled", async () => {
	const { calls } = mockJsonFetch({ success: true });
	const chat = sessionWithMessages(3);

	await new RemoteStorage("https://example.test", () => null, { saveLimit: 0 }).save(chat);
	await new RemoteStorage("https://example.test", () => null, { saveLimit: -1 }).save(chat);
	await new RemoteStorage("https://example.test", () => null, { saveLimit: Number.POSITIVE_INFINITY }).save(chat);

	for (const call of calls) {
		assert.deepEqual(JSON.parse(call.init.body as string), chat);
		assert.deepEqual(call.init.headers, { "Content-Type": "application/json" });
	}
});

test("encodes chat ids as remote URL path segments", async () => {
	const { calls } = mockJsonFetch({ id: "chat/with spaces", title: "A chat", updatedAt: 123, messages: [] });
	const storage = new RemoteStorage("https://example.test", () => null);

	await storage.loadOne("chat/with spaces");

	assert.equal(calls[0].url, "https://example.test/api/chats/chat%2Fwith%20spaces");
});

test("write methods throw on non-OK responses", async () => {
	const storage = new RemoteStorage("https://example.test", () => null);

	globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;

	await assert.rejects(() => storage.save(session()), /Failed to save chat/);
	await assert.rejects(() => storage.updateMetadata("chat-1", { title: "Nope" }), /Failed to update chat metadata/);
	await assert.rejects(() => storage.delete("chat-1"), /Failed to delete chat/);
});
