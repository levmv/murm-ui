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

	assert.equal(calls[1].url, "https://example.test/api/chats/chat-1/meta");
	assert.equal(calls[1].init.method, "POST");
	assert.deepEqual(JSON.parse(calls[1].init.body as string), { title: "Renamed" });

	assert.equal(calls[2].url, "https://example.test/api/chats/chat-1");
	assert.equal(calls[2].init.method, "DELETE");
});

test("write methods throw on non-OK responses", async () => {
	const storage = new RemoteStorage("https://example.test", () => null);

	globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;

	await assert.rejects(() => storage.save(session()), /Failed to save chat/);
	await assert.rejects(() => storage.updateMetadata("chat-1", { title: "Nope" }), /Failed to update chat metadata/);
	await assert.rejects(() => storage.delete("chat-1"), /Failed to delete chat/);
});
