import * as assert from "node:assert/strict";
import { test } from "node:test";
import { ChatEngine } from "./chat-engine";
import type { ConversationChange } from "./conversation-types";
import type {
	ChatPlugin,
	ChatProvider,
	ChatRequest,
	ChatSession,
	ChatSessionMeta,
	ChatStorage,
	ChatStreamRequest,
	ContentBlock,
	Message,
	PaginatedSessions,
	RequestOptions,
} from "./types";

class MemoryStorage implements ChatStorage {
	public sessions = new Map<string, ChatSession>();
	public metas: ChatSessionMeta[] = [];
	public saved: ChatSession[] = [];
	public deleted: string[] = [];
	public metadataUpdates: { id: string; meta: Partial<ChatSessionMeta> }[] = [];
	public loadOneCalls: string[] = [];

	constructor(sessions: ChatSession[] = []) {
		for (const session of sessions) {
			this.sessions.set(session.id, session);
			this.metas.push({
				id: session.id,
				title: session.title,
				updatedAt: session.updatedAt,
				...(typeof session.isPinned === "boolean" ? { isPinned: session.isPinned } : {}),
			});
		}
	}

	async loadSessions(limit: number, cursor?: ChatSessionMeta): Promise<PaginatedSessions> {
		let metas = [...this.metas].sort((a, b) => {
			const pinnedDelta = Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned));
			if (pinnedDelta !== 0) return pinnedDelta;
			return b.updatedAt - a.updatedAt || b.id.localeCompare(a.id);
		});

		if (cursor) {
			const cursorIndex = metas.findIndex(
				(session) =>
					Boolean(session.isPinned) === Boolean(cursor.isPinned) &&
					session.updatedAt === cursor.updatedAt &&
					session.id === cursor.id,
			);
			if (cursorIndex >= 0) metas = metas.slice(cursorIndex + 1);
		}

		return { items: metas.slice(0, limit), hasMore: metas.length > limit };
	}

	async loadOne(id: string): Promise<ChatSession | null> {
		this.loadOneCalls.push(id);
		return this.sessions.get(id) ?? null;
	}

	async save(session: ChatSession): Promise<void> {
		this.saved.push(session);
		this.sessions.set(session.id, session);

		const previousMeta = this.metas.find((s) => s.id === session.id);
		const isPinned = typeof session.isPinned === "boolean" ? session.isPinned : previousMeta?.isPinned;
		const meta = {
			id: session.id,
			title: session.title,
			updatedAt: session.updatedAt,
			...(typeof isPinned === "boolean" ? { isPinned } : {}),
		};
		this.metas = [meta, ...this.metas.filter((s) => s.id !== session.id)];
	}

	async updateMetadata(id: string, meta: Partial<ChatSessionMeta>): Promise<void> {
		this.metadataUpdates.push({ id, meta });
		this.metas = this.metas.map((session) => (session.id === id ? { ...session, ...meta } : session));
	}

	async delete(id: string): Promise<void> {
		this.deleted.push(id);
		this.sessions.delete(id);
		this.metas = this.metas.filter((session) => session.id !== id);
	}
}

function textMessage(id: string, role: "user" | "assistant", text: string): Message {
	return {
		id,
		role,
		blocks: [{ id: `${id}-text`, type: "text", text }],
	};
}

function fileBlock(id = "file-1"): Extract<ContentBlock, { type: "file" }> {
	return {
		id,
		type: "file",
		mimeType: "text/plain",
		name: "notes.txt",
		data: "important context",
	};
}

function getText(message: Message): string {
	return message.blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n\n");
}

async function waitFor(assertion: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 20; i++) {
		if (assertion()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	assert.fail(`Timed out waiting for ${label}`);
}

function replyingProvider(reply: string): ChatProvider {
	return {
		async streamChat(request: ChatStreamRequest, onChange: (changes: ConversationChange[]) => void): Promise<void> {
			onChange([
				{ type: "block.put", messageId: request.messageId, block: { id: "reply-text", type: "text", text: reply } },
			]);
		},
	};
}

test("sessions.loadHistory lists stored sessions while a clean URL starts a blank chat", async () => {
	const older = {
		id: "older",
		title: "Older chat",
		updatedAt: 100,
		messages: [textMessage("older-user", "user", "old question")],
	};
	const latest = {
		id: "latest",
		title: "Latest chat",
		updatedAt: 200,
		messages: [textMessage("latest-user", "user", "new question")],
	};
	const storage = new MemoryStorage([older, latest]);

	const engine = new ChatEngine({ provider: replyingProvider("unused"), storage });

	assert.equal(engine.state.isLoadingSession, false);
	assert.equal(engine.state.isLoadingSessions, false);
	assert.equal(engine.state.sessions.length, 0);

	void engine.sessions.loadHistory();
	assert.equal(engine.state.isLoadingSessions, true);
	await waitFor(() => !engine.state.isLoadingSessions, "session history load");

	assert.notEqual(engine.state.currentSessionId, "latest");
	assert.notEqual(engine.state.currentSessionId, "older");
	assert.deepEqual(
		engine.state.sessions.map((session) => session.id),
		["latest", "older"],
	);
	assert.deepEqual(engine.state.messages, []);
	assert.deepEqual(storage.loadOneCalls, []);
});

test("sessions.updatePinned persists metadata, sorts pinned first, and enforces the pin limit", async () => {
	const storage = new MemoryStorage([
		{ id: "pin-1", title: "Pinned 1", updatedAt: 100, isPinned: true, messages: [] },
		{ id: "pin-2", title: "Pinned 2", updatedAt: 200, isPinned: true, messages: [] },
		{ id: "pin-3", title: "Pinned 3", updatedAt: 300, isPinned: true, messages: [] },
		{ id: "chat-1", title: "Regular", updatedAt: 400, messages: [] },
	]);
	const engine = new ChatEngine({ provider: replyingProvider("ok"), storage });

	await engine.sessions.loadHistory();
	await engine.sessions.updatePinned("chat-1", true);

	assert.equal(engine.state.sessions.find((session) => session.id === "chat-1")?.isPinned, undefined);
	assert.equal(storage.metadataUpdates.length, 0);

	await engine.sessions.updatePinned("pin-1", false);
	await engine.sessions.updatePinned("chat-1", true);

	assert.deepEqual(storage.metadataUpdates, [
		{ id: "pin-1", meta: { isPinned: false } },
		{ id: "chat-1", meta: { isPinned: true } },
	]);
	assert.deepEqual(
		engine.state.sessions.map((session) => session.id),
		["chat-1", "pin-3", "pin-2", "pin-1"],
	);
});

test("invalid input is rejected before acceptance and does not leave a generation running", async (t) => {
	const storage = new MemoryStorage();
	const engine = new ChatEngine({ provider: replyingProvider("reply"), storage });
	t.after(() => engine.destroy());
	const block: ContentBlock = { id: "duplicate", type: "file", mimeType: "text/plain", data: "file" };
	assert.throws(() => engine.sendMessage("Draft", [block, block]), /Duplicate/);
	assert.equal(engine.state.generatingMessageId, null);
	assert.equal(engine.state.messages.length, 0);
	assert.equal(engine.sendMessage("Valid", [block]), true);
	await waitFor(() => storage.saved.length === 1, "valid submission after rejection");
});

test("session saves and title updates preserve pinned metadata", async () => {
	const storage = new MemoryStorage([
		{
			id: "chat-1",
			title: "Pinned chat",
			updatedAt: 100,
			isPinned: true,
			messages: [textMessage("msg-1", "user", "hello")],
		},
	]);
	const engine = new ChatEngine({ provider: replyingProvider("reply"), storage });

	await engine.sessions.loadHistory();
	await engine.sessions.switch("chat-1");
	await engine.sendMessage("next");
	await waitFor(() => storage.saved.length === 1, "session save");
	await engine.sessions.updateTitle("chat-1", "  Better title  ");

	assert.equal(storage.saved[0].isPinned, true);
	assert.deepEqual(storage.metadataUpdates, [{ id: "chat-1", meta: { title: "Better title" } }]);
	assert.equal(engine.state.sessions.find((session) => session.id === "chat-1")?.isPinned, true);
});

test("initial load can open a session that is not in the first sidebar page", async () => {
	const listed = {
		id: "listed",
		title: "Listed chat",
		updatedAt: 200,
		messages: [textMessage("listed-user", "user", "listed question")],
	};
	const deepLinked = {
		id: "deep-linked",
		title: "Deep link",
		updatedAt: 100,
		messages: [textMessage("deep-user", "user", "linked question")],
	};
	const storage = new (class extends MemoryStorage {
		override async loadSessions(): Promise<PaginatedSessions> {
			return { items: [{ id: listed.id, title: listed.title, updatedAt: listed.updatedAt }], hasMore: false };
		}
	})([listed, deepLinked]);

	const engine = new ChatEngine({ provider: replyingProvider("unused"), storage, initialSessionId: deepLinked.id });

	await waitFor(() => !engine.state.isLoadingSession, "deep-linked session load");

	assert.equal(engine.state.currentSessionId, deepLinked.id);
	assert.equal(getText(engine.state.messages[0]), "linked question");
	assert.deepEqual(
		engine.state.sessions.map((session) => session.id),
		["deep-linked"],
	);

	void engine.sessions.loadHistory();
	await waitFor(() => !engine.state.isLoadingSessions, "deep-linked sidebar load");
	assert.deepEqual(
		engine.state.sessions.map((session) => session.id),
		["listed", "deep-linked"],
	);
});

test("invalid initial session URL starts a blank chat with a global error", async (t) => {
	t.mock.method(console, "error", () => {});

	const latest = {
		id: "latest",
		title: "Latest chat",
		updatedAt: 200,
		messages: [textMessage("latest-user", "user", "new question")],
	};
	const storage = new MemoryStorage([latest]);

	const engine = new ChatEngine({ provider: replyingProvider("unused"), storage, initialSessionId: "missing-chat" });

	await waitFor(() => !engine.state.isLoadingSession, "invalid initial session fallback");

	const state = engine.state;
	assert.notEqual(state.currentSessionId, "missing-chat");
	assert.equal(state.currentSessionId.length > 0, true);
	assert.equal(state.sessions.length, 0);
	assert.deepEqual(state.messages, []);
	assert.deepEqual(state.error, { message: "Chat not found. Started a new one." });
	assert.deepEqual(storage.loadOneCalls, ["missing-chat"]);

	engine.clearError();
	assert.equal(engine.state.error, null);
});

test("failed session switch starts a blank chat with a fresh internal id", async (t) => {
	t.mock.method(console, "error", () => {});

	const latest = {
		id: "latest",
		title: "Latest chat",
		updatedAt: 200,
		messages: [textMessage("latest-user", "user", "new question")],
	};
	const storage = new MemoryStorage([latest]);
	const engine = new ChatEngine({ provider: replyingProvider("hello back"), storage });

	await engine.sessions.switch("missing-chat");

	const fallbackId = engine.state.currentSessionId;
	assert.notEqual(fallbackId, "missing-chat");
	assert.deepEqual(engine.state.messages, []);
	assert.deepEqual(engine.state.error, { message: "Failed to load chat. Started a new one." });
	assert.deepEqual(storage.loadOneCalls, ["missing-chat"]);

	engine.sendMessage("hello");
	await waitFor(() => engine.state.generatingMessageId === null && storage.saved.length === 1, "fallback save");

	assert.equal(storage.saved[0].id, fallbackId);
	assert.notEqual(storage.saved[0].id, "missing-chat");
});

test("history loading failure does not block a routed session", async () => {
	const routed = {
		id: "url-chat",
		title: "URL Chat",
		updatedAt: 300,
		messages: [textMessage("url-user", "user", "linked question")],
	};
	const storage = new (class extends MemoryStorage {
		override async loadSessions(): Promise<PaginatedSessions> {
			throw new Error("IndexedDB unavailable");
		}
	})([routed]);
	const originalConsoleError = console.error;
	console.error = () => {};

	try {
		const engine = new ChatEngine({ provider: replyingProvider("unused"), storage, initialSessionId: "url-chat" });
		void engine.sessions.loadHistory();

		await waitFor(
			() => !engine.state.isLoadingSession && !engine.state.isLoadingSessions,
			"routed load and history failure",
		);

		assert.equal(engine.state.currentSessionId, "url-chat");
		assert.equal(getText(engine.state.messages[0]), "linked question");
		assert.deepEqual(engine.state.error, { message: "Failed to load chat history." });
	} finally {
		console.error = originalConsoleError;
	}
});

test("sendMessage streams an assistant reply and persists the session", async () => {
	const storage = new MemoryStorage();
	const engine = new ChatEngine({ provider: replyingProvider("hello back"), storage });

	engine.sendMessage("hello");
	await waitFor(() => engine.state.generatingMessageId === null && storage.saved.length === 1, "stream finalization");

	const state = engine.state;
	assert.equal(state.messages.length, 2);
	assert.equal(state.messages[0].role, "user");
	assert.equal(getText(state.messages[0]), "hello");
	assert.equal(state.messages[1].role, "assistant");
	assert.equal(getText(state.messages[1]), "hello back");
	assert.equal(state.messages[0].runId, state.messages[0].id);
	assert.equal(state.messages[1].runId, state.messages[0].id);
	assert.equal(state.messages[1].ephemeral, undefined);
	assert.equal(storage.saved[0].title, "hello");
	assert.equal(state.sessions[0].id, state.currentSessionId);
});

test("provider updates interleave messages without changing their addresses", async () => {
	const storage = new MemoryStorage();
	let responseId = "";
	const provider: ChatProvider = {
		async streamChat(request, onChange) {
			responseId = request.messageId;
			onChange([
				{ type: "block.put", messageId: responseId, block: { id: "text-1", type: "text", text: "first" } },
				{
					type: "message.put",
					message: {
						id: "assistant-2",
						role: "assistant",
						runId: request.runId,
						status: "streaming",
						blocks: [{ id: "text-2", type: "text", text: "second" }],
					},
				},
			]);
			onChange([{ type: "message.state", messageId: responseId, usage: { input: 2, output: 3, total: 5 } }]);
			assert.equal(engine.conversation.getMessage(responseId)!.status, "streaming");
			onChange([{ type: "text.append", messageId: responseId, blockId: "text-1", delta: " A" }]);
			onChange([{ type: "message.state", messageId: "assistant-2", status: "complete" }]);
			onChange([{ type: "text.append", messageId: responseId, blockId: "text-1", delta: " B" }]);
		},
	};
	const engine = new ChatEngine({ provider, storage });
	engine.sendMessage("hello");
	const pendingId = engine.state.generatingMessageId;
	await waitFor(() => storage.saved.length === 1, "stream finalization");
	const [user, first, second] = engine.state.messages;
	assert.equal(first.id, pendingId);
	assert.equal(first.id, responseId);
	assert.equal(first.runId, user.id);
	assert.equal(second.runId, user.id);
	assert.equal(getText(first), "first A B");
	assert.equal(getText(second), "second");
	assert.equal(first.status, "complete");
	assert.equal(second.status, "complete");
	assert.equal(storage.saved[0].messages.length, 3);
});

test("navigating on generation completion saves the finished transcript, not the next chat", async (t) => {
	const storage = new MemoryStorage();
	const engine = new ChatEngine({ provider: replyingProvider("answer"), storage });
	t.after(() => engine.destroy());
	const sessionId = engine.state.currentSessionId;
	engine.onChange(
		(state) => state.generatingMessageId,
		(id) => {
			if (id === null) void engine.sessions.create();
		},
	);
	engine.sendMessage("Question");
	await waitFor(() => storage.saved.length === 1, "save on completion");
	assert.notEqual(engine.state.currentSessionId, sessionId);
	assert.equal(storage.saved[0].id, sessionId);
	assert.deepEqual(storage.saved[0].messages.map(getText), ["Question", "answer"]);
});

test("switching chats during persistence waits only when reopening the saving session", async () => {
	const { promise: saveReleased, resolve: releaseSave } = Promise.withResolvers<void>();

	const { promise: saveStartedPromise, resolve: saveStarted } = Promise.withResolvers<void>();

	const otherSession: ChatSession = {
		id: "other-session",
		title: "Other chat",
		updatedAt: 100,
		messages: [textMessage("other-user", "user", "other question")],
	};
	const storage = new (class extends MemoryStorage {
		override async save(session: ChatSession): Promise<void> {
			saveStarted();
			await saveReleased;
			await super.save(session);
		}
	})([otherSession]);

	const engine = new ChatEngine({ provider: replyingProvider("hello back"), storage });

	const originalId = engine.state.currentSessionId;
	engine.sendMessage("hello");
	await saveStartedPromise;
	await waitFor(() => engine.state.generatingMessageId === null, "generation indicator cleared");

	await engine.sessions.switch(otherSession.id);
	assert.equal(engine.state.currentSessionId, otherSession.id);
	assert.equal(getText(engine.state.messages[0]), "other question");

	const superseded = engine.sessions.switch(originalId);
	await engine.sessions.switch(otherSession.id);
	const returning = engine.sessions.switch(originalId);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(engine.state.isLoadingSession, true);
	assert.equal(storage.loadOneCalls.includes(originalId), false, "do not read a stale or not-yet-created session");

	releaseSave();
	await Promise.all([superseded, returning]);

	assert.equal(engine.state.currentSessionId, originalId);
	assert.deepEqual(engine.state.messages.map(getText), ["hello", "hello back"]);
	assert.equal(storage.loadOneCalls.filter((id) => id === originalId).length, 1);
	assert.equal(engine.state.error, null);
	assert.equal(
		engine.state.sessions.some((session) => session.id === storage.saved[0].id),
		true,
	);
	await engine.destroy();
});

test("latest navigation wins while an earlier transition waits for generation persistence", async (t) => {
	for (const [first, last] of [
		["switch", "switch"],
		["switch", "create"],
		["switch", "current"],
		["create", "switch"],
	] as const) {
		await t.test(`${first} followed by ${last}`, async (t) => {
			const streamStarted = Promise.withResolvers<void>();
			const saveStarted = Promise.withResolvers<void>();
			const saveReleased = Promise.withResolvers<void>();
			const storage = new (class extends MemoryStorage {
				override async save(session: ChatSession): Promise<void> {
					saveStarted.resolve();
					await saveReleased.promise;
					await super.save(session);
				}
			})(["a", "b"].map((id) => ({ id, title: id, updatedAt: 1, messages: [textMessage(id, "user", id)] })));
			const engine = new ChatEngine({
				storage,
				provider: {
					async streamChat(request, onChange) {
						onChange([
							{
								type: "block.put",
								messageId: request.messageId,
								block: { id: "partial", type: "text", text: "Partial reply" },
							},
						]);
						const aborted = new Promise<void>((resolve) =>
							request.signal.addEventListener("abort", () => resolve(), { once: true }),
						);
						streamStarted.resolve();
						await aborted;
					},
				},
			});
			t.after(() => engine.destroy());
			const originalId = engine.state.currentSessionId;
			engine.sendMessage("Question");
			await streamStarted.promise;
			const earlier = first === "create" ? engine.sessions.create() : engine.sessions.switch("a");
			await saveStarted.promise;
			if (last === "create") await engine.sessions.create();
			else await engine.sessions.switch(last === "current" ? originalId : "b");
			const latest = engine.conversation.state;
			if (last === "create") assert.notEqual(latest.id, originalId);
			else assert.equal(latest.id, last === "current" ? originalId : "b");

			saveReleased.resolve();
			await earlier;
			assert.equal(engine.conversation.state, latest);
			assert.equal(engine.state.isLoadingSession, false);
			assert.equal(engine.state.error, null);
			assert.equal(storage.loadOneCalls.includes("a"), false);
			assert.equal(storage.saved.length, 1);
			assert.equal(storage.saved[0].id, originalId);
			assert.deepEqual(storage.saved[0].messages.map(getText), ["Question", "Partial reply"]);
		});
	}
});

test("overlapping saves finish in request order before storage closes", async () => {
	const { promise: firstSaveReleased, resolve: releaseFirstSave } = Promise.withResolvers<void>();

	const { promise: firstSaveStartedPromise, resolve: firstSaveStarted } = Promise.withResolvers<void>();

	const storage = new (class extends MemoryStorage {
		private saveCount = 0;
		closeCalls = 0;

		override async save(session: ChatSession): Promise<void> {
			this.saveCount++;
			if (this.saveCount === 1) {
				firstSaveStarted();
				await firstSaveReleased;
			}
			assert.equal(this.closeCalls, 0);
			await super.save(session);
		}

		close(): void {
			this.closeCalls++;
		}
	})();

	let replyCount = 0;
	const provider: ChatProvider = {
		async streamChat(request: ChatStreamRequest, onChange: (changes: ConversationChange[]) => void): Promise<void> {
			replyCount++;
			onChange([
				{
					type: "block.put",
					messageId: request.messageId,
					block: { id: `reply-${replyCount}`, type: "text", text: replyCount === 1 ? "first reply" : "second reply" },
				},
			]);
		},
	};
	const engine = new ChatEngine({ provider, storage });

	engine.sendMessage("first");
	await firstSaveStartedPromise;
	await waitFor(() => engine.state.generatingMessageId === null, "first generation indicator cleared");

	assert.equal(engine.sendMessage("second"), true);
	await waitFor(() => replyCount === 2 && engine.state.generatingMessageId === null, "second generation completed");

	assert.equal(storage.saved.length, 0);
	let notifications = 0;
	engine.onChange(
		(state) => state.sessions,
		() => notifications++,
	);
	const closing = engine.destroy();
	assert.equal(engine.destroy(), closing);
	assert.equal(engine.sendMessage("after destroy"), false);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(storage.closeCalls, 0);
	releaseFirstSave();
	await closing;
	assert.equal(storage.saved.length, 2);
	assert.equal(storage.closeCalls, 1);
	assert.equal(notifications, 0);

	const finalSaved = storage.saved[1];
	assert.equal(getText(finalSaved.messages[0]), "first");
	assert.equal(getText(finalSaved.messages[1]), "first reply");
	assert.equal(getText(finalSaved.messages[2]), "second");
	assert.equal(getText(finalSaved.messages[3]), "second reply");
	assert.deepEqual(storage.sessions.get(finalSaved.id)?.messages, finalSaved.messages);
});

test("deleting a session prevents pending save completions from reinserting it", async () => {
	const { promise: saveReleased, resolve: releaseSave } = Promise.withResolvers<void>();

	const { promise: saveStartedPromise, resolve: saveStarted } = Promise.withResolvers<void>();

	const storage = new (class extends MemoryStorage {
		override async save(session: ChatSession): Promise<void> {
			saveStarted();
			await saveReleased;
			await super.save(session);
		}
	})();
	const engine = new ChatEngine({ provider: replyingProvider("hello back"), storage });

	const sessionId = engine.state.currentSessionId;
	engine.sendMessage("hello");
	await saveStartedPromise;
	await waitFor(() => engine.state.generatingMessageId === null, "generation indicator cleared");

	const deletePromise = engine.sessions.delete(sessionId);
	assert.notEqual(engine.state.currentSessionId, sessionId);
	assert.equal(
		engine.state.sessions.some((session) => session.id === sessionId),
		false,
	);

	releaseSave();
	await deletePromise;

	assert.equal(storage.deleted.includes(sessionId), true);
	assert.equal(storage.sessions.has(sessionId), false);
	assert.equal(
		engine.state.sessions.some((session) => session.id === sessionId),
		false,
	);
	assert.notEqual(engine.state.currentSessionId, sessionId);
});

test("storage failures stay visible and failed saves and deletions can be retried", async (t) => {
	t.mock.method(console, "error", () => {});
	let failSave = true;
	let failDelete = true;
	const storage = new (class extends MemoryStorage {
		override async save(session: ChatSession): Promise<void> {
			if (failSave) throw new Error("Storage unavailable");
			await super.save(session);
		}

		override async delete(id: string): Promise<void> {
			if (failDelete) throw new Error("Storage unavailable");
			await super.delete(id);
		}
	})();
	const engine = new ChatEngine({ provider: replyingProvider("answer"), storage });
	t.after(() => engine.destroy());
	const sessionId = engine.state.currentSessionId;
	engine.sendMessage("first");
	await waitFor(() => engine.state.error !== null, "save failure");
	assert.match(engine.state.error!.message, /save/i);
	assert.deepEqual(engine.state.messages.map(getText), ["first", "answer"]);

	failSave = false;
	engine.sendMessage("second");
	await waitFor(() => engine.state.sessions.length === 1, "successful retry");
	assert.equal(engine.state.error, null);
	assert.deepEqual(storage.sessions.get(sessionId)?.messages.map(getText), ["first", "answer", "second", "answer"]);
	const meta = engine.state.sessions[0];
	await engine.sessions.delete(sessionId);
	assert.match(engine.state.error!.message, /delete/i);
	assert.deepEqual(engine.state.sessions, [meta]);
	assert.ok(storage.sessions.has(sessionId));
	await engine.sessions.switch(sessionId);
	assert.equal(engine.state.currentSessionId, sessionId);
	assert.deepEqual(engine.state.messages.map(getText), ["first", "answer", "second", "answer"]);

	failDelete = false;
	await engine.sessions.delete(sessionId);
	assert.equal(storage.sessions.has(sessionId), false);
	assert.deepEqual(engine.state.sessions, []);
	assert.equal(engine.state.error, null);
});

test("auto-title completion is scoped to the generated session after switching away", async () => {
	const { promise: saveReleased, resolve: releaseSave } = Promise.withResolvers<void>();

	const { promise: saveStartedPromise, resolve: saveStarted } = Promise.withResolvers<void>();

	const { promise: titleStartedPromise, resolve: titleStarted } = Promise.withResolvers<void>();

	const { promise: titleReleased, resolve: releaseTitle } = Promise.withResolvers<void>();

	const otherSession: ChatSession = {
		id: "other-session",
		title: "Other chat",
		updatedAt: 100,
		messages: [textMessage("other-user", "user", "other question")],
	};
	const storage = new (class extends MemoryStorage {
		override async save(session: ChatSession): Promise<void> {
			saveStarted();
			await saveReleased;
			await super.save(session);
		}
	})([otherSession]);

	const provider: ChatProvider = {
		async streamChat(request: ChatStreamRequest, onChange: (changes: ConversationChange[]) => void): Promise<void> {
			onChange([
				{ type: "block.put", messageId: request.messageId, block: { id: "reply-text", type: "text", text: "answer" } },
			]);
		},
		async generateTitle(): Promise<string> {
			titleStarted();
			await titleReleased;
			return "Smart Title";
		},
	};
	const engine = new ChatEngine({ provider, storage });

	const generatedSessionId = engine.state.currentSessionId;
	engine.sendMessage("hello");
	await saveStartedPromise;
	await waitFor(() => engine.state.generatingMessageId === null, "generation indicator cleared");

	await engine.sessions.switch(otherSession.id);
	releaseSave();
	await titleStartedPromise;

	assert.equal(engine.state.currentSessionId, otherSession.id);
	assert.equal(getText(engine.state.messages[0]), "other question");

	releaseTitle();
	await waitFor(() => storage.metadataUpdates.length === 1, "auto-title metadata update");

	assert.deepEqual(storage.metadataUpdates, [{ id: generatedSessionId, meta: { title: "Smart Title" } }]);
	assert.equal(engine.state.currentSessionId, otherSession.id);
	assert.equal(getText(engine.state.messages[0]), "other question");
	assert.equal(engine.state.sessions.find((session) => session.id === generatedSessionId)?.title, "Smart Title");
});

test("deleting a session prevents pending auto-title completion from recreating it", async () => {
	const { promise: titleStartedPromise, resolve: titleStarted } = Promise.withResolvers<void>();

	const { promise: titleReleased, resolve: releaseTitle } = Promise.withResolvers<void>();

	const storage = new MemoryStorage();
	const provider: ChatProvider = {
		async streamChat(request: ChatStreamRequest, onChange: (changes: ConversationChange[]) => void): Promise<void> {
			onChange([
				{ type: "block.put", messageId: request.messageId, block: { id: "reply-text", type: "text", text: "answer" } },
			]);
		},
		async generateTitle(): Promise<string> {
			titleStarted();
			await titleReleased;
			return "Smart Title";
		},
	};
	const engine = new ChatEngine({ provider, storage });

	const sessionId = engine.state.currentSessionId;
	engine.sendMessage("hello");
	await titleStartedPromise;

	const deletePromise = engine.sessions.delete(sessionId);
	assert.notEqual(engine.state.currentSessionId, sessionId);

	await deletePromise;
	releaseTitle();
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.deepEqual(storage.metadataUpdates, []);
	assert.equal(storage.sessions.has(sessionId), false);
	assert.equal(
		engine.state.sessions.some((session) => session.id === sessionId),
		false,
	);
	assert.notEqual(engine.state.currentSessionId, sessionId);
});

test("destroy aborts auto-title before generation shutdown and ignores its late result", async () => {
	let titleSignal: AbortSignal | null = null;
	const { promise: titleStartedPromise, resolve: titleStarted } = Promise.withResolvers<void>();

	const { promise: titleReleased, resolve: releaseTitle } = Promise.withResolvers<void>();

	const { promise: secondStreamStartedPromise, resolve: secondStreamStarted } = Promise.withResolvers<void>();

	const { promise: secondStreamReleased, resolve: releaseSecondStream } = Promise.withResolvers<void>();

	const storage = new MemoryStorage();
	let streamCalls = 0;
	const provider: ChatProvider = {
		async streamChat(request: ChatStreamRequest, onChange: (changes: ConversationChange[]) => void): Promise<void> {
			streamCalls++;
			if (streamCalls === 1) {
				onChange([
					{
						type: "block.put",
						messageId: request.messageId,
						block: { id: "first-reply", type: "text", text: "answer" },
					},
				]);

				return;
			}

			secondStreamStarted();
			await secondStreamReleased;
		},
		async generateTitle(request): Promise<string> {
			titleSignal = request.signal;
			titleStarted();
			await titleReleased;
			return "Late Title";
		},
	};
	const engine = new ChatEngine({ provider, storage });

	engine.sendMessage("first");
	await titleStartedPromise;

	assert.equal(engine.sendMessage("second"), true);
	await secondStreamStartedPromise;

	const destroyPromise = engine.destroy();
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.ok(titleSignal);
	assert.equal((titleSignal as AbortSignal).aborted, true);

	releaseSecondStream();
	await destroyPromise;
	releaseTitle();
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.deepEqual(storage.metadataUpdates, []);
});

test("sendMessage preserves encrypted reasoning as hidden metadata", async () => {
	const storage = new MemoryStorage();
	const engine = new ChatEngine({
		provider: {
			async streamChat(request: ChatStreamRequest, onChange: (changes: ConversationChange[]) => void): Promise<void> {
				onChange([
					{
						type: "block.put",
						messageId: request.messageId,
						block: {
							id: "hidden-reasoning",
							type: "reasoning",
							text: "",
							encrypted: true,
							encryptedText: "ciphertext",
						},
					},
				]);
			},
		},
		storage,
	});

	engine.sendMessage("hello");
	await waitFor(() => engine.state.generatingMessageId === null && storage.saved.length === 1, "stream finalization");

	const reasoningBlock = engine.state.messages[1].blocks.find(
		(block): block is Extract<ContentBlock, { type: "reasoning" }> => block.type === "reasoning",
	);
	assert.ok(reasoningBlock);
	assert.equal(reasoningBlock.encrypted, true);
	assert.equal(reasoningBlock.text, "");
	assert.equal(reasoningBlock.encryptedText, "ciphertext");
	assert.deepEqual(storage.saved[0].messages[1].blocks, [reasoningBlock]);
});

test("empty encrypted reasoning leaves an ephemeral assistant placeholder out of storage", async () => {
	const storage = new MemoryStorage();
	const engine = new ChatEngine({
		provider: {
			async streamChat(request: ChatStreamRequest, onChange: (changes: ConversationChange[]) => void): Promise<void> {
				onChange([
					{
						type: "block.put",
						messageId: request.messageId,
						block: { id: "hidden-reasoning", type: "reasoning", text: "", encrypted: true, encryptedText: undefined },
					},
				]);
			},
		},
		storage,
	});

	engine.sendMessage("hello");
	await waitFor(() => engine.state.generatingMessageId === null && storage.saved.length === 1, "stream finalization");

	const reasoningBlock = engine.state.messages[1].blocks.find(
		(block): block is Extract<ContentBlock, { type: "reasoning" }> => block.type === "reasoning",
	);
	assert.ok(reasoningBlock);
	assert.equal(reasoningBlock.encrypted, true);
	assert.equal(reasoningBlock.text, "");
	assert.equal(reasoningBlock.encryptedText, undefined);
	assert.equal(engine.state.messages[1].ephemeral, true);
	assert.equal(storage.saved[0].messages.length, 1);
});

test("failed generation keeps empty assistant message in state but omits it from storage", async () => {
	const storage = new MemoryStorage();
	const engine = new ChatEngine({
		provider: {
			async streamChat(): Promise<void> {
				throw new Error("Provider failed");
			},
		},
		storage,
	});

	engine.sendMessage("hello");
	await waitFor(() => engine.state.generatingMessageId === null && storage.saved.length === 1, "failure finalization");

	const state = engine.state;
	assert.equal(state.messages.length, 2);
	assert.equal(state.messages[1].role, "assistant");
	assert.deepEqual(state.messages[1].blocks, []);
	assert.equal(state.messages[1].ephemeral, true);
	assert.deepEqual(state.error, { message: "Provider failed", id: state.messages[1].id });
	assert.deepEqual(storage.saved[0].messages, [state.messages[0]]);
});

test("a run failure after message completion remains visible as a global error", async () => {
	const storage = new MemoryStorage();
	const engine = new ChatEngine({
		storage,
		provider: {
			async streamChat(request, onChange) {
				onChange([
					{
						type: "block.put",
						messageId: request.messageId,
						block: { id: "text", type: "text", text: "Accepted result" },
					},
					{ type: "message.state", messageId: request.messageId, status: "complete" },
				]);
				throw new Error("Stream disconnected");
			},
		},
	});
	engine.sendMessage("hello");
	await waitFor(() => storage.saved.length === 1, "failed run save");
	assert.equal(engine.state.messages[1].status, "complete");
	assert.deepEqual(engine.state.error, { message: "Stream disconnected" });
});

test("failed generation marks streaming tool calls as errored", async () => {
	const storage = new MemoryStorage();
	const engine = new ChatEngine({
		provider: {
			async streamChat(request: ChatStreamRequest, onChange: (changes: ConversationChange[]) => void): Promise<void> {
				onChange([
					{
						type: "block.put",
						messageId: request.messageId,
						block: {
							id: "tool-1",
							type: "tool_call",
							toolCallId: "call-1",
							name: "lookup_weather",
							argsText: '{"q":"weather"}',
							status: "streaming",
						},
					},
				]);
				throw new Error("Provider failed");
			},
		},
		storage,
	});

	engine.sendMessage("hello");
	await waitFor(() => engine.state.generatingMessageId === null && storage.saved.length === 1, "failure finalization");

	const assistant = engine.state.messages[1];
	const toolCall = assistant.blocks.find(
		(block): block is Extract<ContentBlock, { type: "tool_call" }> => block.type === "tool_call",
	);

	assert.ok(toolCall);
	assert.equal(toolCall.status, "error");
	assert.deepEqual(engine.state.error, { message: "Provider failed", id: assistant.id });
});

test("sendMessage works while initial history is loading", async () => {
	const { promise: loadReleased, resolve: releaseLoad } = Promise.withResolvers<void>();

	const { promise: loadStartedPromise, resolve: loadStarted } = Promise.withResolvers<void>();

	const storage = new (class extends MemoryStorage {
		override async loadSessions(limit: number, cursor?: ChatSessionMeta): Promise<PaginatedSessions> {
			loadStarted();
			await loadReleased;
			return super.loadSessions(limit, cursor);
		}
	})();

	let pluginCalled = false;
	let providerCalls = 0;

	const engine = new ChatEngine({
		provider: {
			async streamChat(request: ChatStreamRequest, onChange: (changes: ConversationChange[]) => void): Promise<void> {
				providerCalls++;
				onChange([
					{ type: "block.put", messageId: request.messageId, block: { id: "reply-text", type: "text", text: "ok" } },
				]);
			},
		},
		storage,
	});
	void engine.sessions.loadHistory();
	engine.registerPlugins([
		{
			name: "submit-spy",
			beforeSubmit: () => {
				pluginCalled = true;
				return undefined;
			},
		},
	]);

	await loadStartedPromise;
	assert.equal(engine.state.isLoadingSession, false);
	assert.equal(engine.state.isLoadingSessions, true);

	engine.sendMessage("hello");
	await waitFor(() => engine.state.generatingMessageId === null && storage.saved.length === 1, "stream finalization");

	assert.equal(pluginCalled, true);
	assert.equal(providerCalls, 1);
	assert.equal(getText(engine.state.messages[0]), "hello");
	assert.equal(getText(engine.state.messages[1]), "ok");

	releaseLoad();
	await waitFor(() => !engine.state.isLoadingSessions, "initial history completion");
});

test("sendMessage is ignored while a routed session is loading", async () => {
	const routed = {
		id: "url-chat",
		title: "URL Chat",
		updatedAt: 100,
		messages: [textMessage("url-user", "user", "linked question")],
	};

	const { promise: loadOneReleased, resolve: releaseLoadOne } = Promise.withResolvers<void>();

	const { promise: loadOneStartedPromise, resolve: loadOneStarted } = Promise.withResolvers<void>();

	const storage = new (class extends MemoryStorage {
		override async loadOne(id: string): Promise<ChatSession | null> {
			loadOneStarted();
			await loadOneReleased;
			return super.loadOne(id);
		}
	})([routed]);

	let pluginCalled = false;
	let providerCalled = false;

	const engine = new ChatEngine({
		provider: {
			async streamChat(): Promise<void> {
				providerCalled = true;
			},
		},
		storage,
		initialSessionId: routed.id,
	});
	engine.registerPlugins([
		{
			name: "submit-spy",
			beforeSubmit: () => {
				pluginCalled = true;
				return undefined;
			},
		},
	]);

	await loadOneStartedPromise;
	engine.sendMessage("hello");
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(pluginCalled, false);
	assert.equal(providerCalled, false);
	assert.equal(engine.state.generatingMessageId, null);
	assert.deepEqual(engine.state.messages, []);

	releaseLoadOne();
	await waitFor(() => !engine.state.isLoadingSession, "routed session load");
});

test("stopping while beforeSubmit is pending prevents the provider request", async () => {
	const { promise: beforeSubmitReleased, resolve: releaseBeforeSubmit } = Promise.withResolvers<void>();

	const { promise: beforeSubmitStartedPromise, resolve: beforeSubmitStarted } = Promise.withResolvers<void>();

	let pluginSawAbortedSignal = false;
	let providerCalled = false;

	const plugin: ChatPlugin = {
		name: "slow-before-submit",
		beforeSubmit: async (params) => {
			assert.equal(params.signal.aborted, false);
			beforeSubmitStarted();
			await beforeSubmitReleased;
			pluginSawAbortedSignal = params.signal.aborted;
			return undefined;
		},
	};

	const provider: ChatProvider = {
		async streamChat(): Promise<void> {
			providerCalled = true;
		},
	};

	const engine = new ChatEngine({
		provider,
		storage: new MemoryStorage(),
	});
	engine.registerPlugins([plugin]);

	engine.sendMessage("hello");
	await beforeSubmitStartedPromise;
	await engine.stopGeneration();

	releaseBeforeSubmit();
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(pluginSawAbortedSignal, true);
	assert.equal(providerCalled, false);
	assert.equal(engine.state.generatingMessageId, null);
	assert.equal(engine.state.messages.length, 1);
	assert.equal(engine.state.messages[0].role, "user");
});

test("stopping after streamed content keeps partial content and ignores late provider updates", async () => {
	const storage = new MemoryStorage();
	const { promise: streamReleased, resolve: releaseStream } = Promise.withResolvers<void>();

	const { promise: streamStartedPromise, resolve: streamStarted } = Promise.withResolvers<void>();

	const provider: ChatProvider = {
		async streamChat(request: ChatStreamRequest, onChange: (changes: ConversationChange[]) => void): Promise<void> {
			onChange([
				{
					type: "block.put",
					messageId: request.messageId,
					block: { id: "partial-text", type: "text", text: "partial" },
				},
			]);
			streamStarted();
			await streamReleased;
			onChange([{ type: "text.append", messageId: request.messageId, blockId: "partial-text", delta: "late" }]);
			throw new Error("Late failure");
		},
	};

	const engine = new ChatEngine({ provider, storage });

	engine.sendMessage("hello");
	await streamStartedPromise;
	await engine.stopGeneration();
	releaseStream();
	await new Promise((resolve) => setTimeout(resolve, 0));

	await waitFor(() => engine.state.generatingMessageId === null && storage.saved.length === 1, "abort finalization");

	const state = engine.state;
	assert.equal(state.messages.length, 2);
	assert.equal(state.messages[1].role, "assistant");
	assert.equal(getText(state.messages[1]), "partial");
	assert.equal(state.messages[1].status, "complete");
	assert.equal(state.error, null);
});

test("setProvider keeps the latest choice while stopping an active generation", async (t) => {
	const storage = new MemoryStorage();
	const started = Promise.withResolvers<void>();
	const engine = new ChatEngine({
		storage,
		provider: {
			async streamChat(request) {
				started.resolve();
				await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
			},
		},
	});
	t.after(() => engine.destroy());

	assert.equal(engine.sendMessage("hello"), true);
	await started.promise;
	const firstChange = engine.setProvider(replyingProvider("earlier"));
	const latestChange = engine.setProvider(replyingProvider("latest"));
	await Promise.all([firstChange, latestChange]);

	assert.equal(engine.sendMessage("next"), true);
	await waitFor(() => storage.saved.length === 2, "reply from the new provider");
	assert.equal(getText(storage.saved[1].messages.at(-1)!), "latest");
});

test("editAndResubmit truncates later history while preserving non-text blocks", async () => {
	let providerMessages: Message[] = [];
	const provider: ChatProvider = {
		async streamChat(request: ChatStreamRequest, onChange: (changes: ConversationChange[]) => void): Promise<void> {
			providerMessages = request.messages;
			onChange([
				{
					type: "block.put",
					messageId: request.messageId,
					block: { id: "edited-reply", type: "text", text: "edited response" },
				},
			]);
		},
	};
	const storage = new MemoryStorage();
	const engine = new ChatEngine({ provider, storage });
	const userMessage: Message = {
		id: "user-1",
		role: "user",
		blocks: [{ id: "old-text", type: "text", text: "old text" }, fileBlock()],
	};

	await engine.setMessages([userMessage, textMessage("assistant-1", "assistant", "old response")]);
	const accepted = engine.editAndResubmit("user-1", "new text");
	await waitFor(() => engine.state.generatingMessageId === null && providerMessages.length > 0, "edited stream");

	assert.equal(accepted, true);
	assert.equal(providerMessages.length, 1);
	assert.equal(getText(providerMessages[0]), "new text");
	assert.equal(providerMessages[0].runId, "user-1");
	assert.ok(providerMessages[0].blocks.some((block) => block.type === "file" && block.name === "notes.txt"));

	const state = engine.state;
	assert.equal(state.messages.length, 2);
	assert.equal(state.messages[0].id, "user-1");
	assert.equal(state.messages[0].runId, "user-1");
	assert.equal(getText(state.messages[0]), "new text");
	assert.equal(state.messages[1].runId, "user-1");
	assert.equal(getText(state.messages[1]), "edited response");
});

test("editAndResubmit rejects edits that would leave a user message empty", async () => {
	let providerCalled = false;
	const engine = new ChatEngine({
		provider: {
			async streamChat(): Promise<void> {
				providerCalled = true;
			},
		},
		storage: new MemoryStorage(),
	});
	const userMessage: Message = {
		id: "user-1",
		role: "user",
		blocks: [{ id: "old-text", type: "text", text: "old text" }],
	};

	await engine.setMessages([userMessage]);
	const accepted = engine.editAndResubmit("user-1", "");
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(accepted, false);
	assert.equal(providerCalled, false);
	assert.equal(engine.state.generatingMessageId, null);
	assert.deepEqual(engine.state.messages, [userMessage]);
});

test("successful generation completes streamed tool calls before saving", async () => {
	const storage = new MemoryStorage();
	const engine = new ChatEngine({
		provider: {
			async streamChat(request: ChatStreamRequest, onChange: (changes: ConversationChange[]) => void): Promise<void> {
				onChange([
					{
						type: "block.put",
						messageId: request.messageId,
						block: {
							id: "tool-1",
							type: "tool_call",
							toolCallId: "call-1",
							name: "lookup_weather",
							argsText: '{"q":"weather"}',
							status: "streaming",
						},
					},
				]);
			},
		},
		storage,
	});

	assert.equal(engine.sendMessage("hello"), true);
	await waitFor(() => engine.state.generatingMessageId === null && storage.saved.length === 1, "tool stream");

	const toolCall = engine.state.messages[1].blocks.find(
		(block): block is Extract<ContentBlock, { type: "tool_call" }> => block.type === "tool_call",
	);

	assert.ok(toolCall);
	assert.equal(toolCall.status, "complete");
	assert.deepEqual(storage.saved[0].messages[1].blocks, [toolCall]);
});

test("setMessages can persist an empty current session", async () => {
	const storage = new MemoryStorage();
	const engine = new ChatEngine({ provider: replyingProvider("unused"), storage });

	const saved = await engine.setMessages([]);

	assert.equal(saved, true);
	assert.equal(storage.saved.length, 1);
	assert.deepEqual(storage.saved[0].messages, []);
	assert.equal(storage.saved[0].title, "Empty Chat");
	assert.equal(engine.state.sessions[0].id, engine.state.currentSessionId);
	assert.equal(engine.state.sessions[0].title, "Empty Chat");
});

test("setMessages omits ephemeral messages but preserves intentionally empty messages", async () => {
	const storage = new MemoryStorage();
	const engine = new ChatEngine({ provider: replyingProvider("unused"), storage });
	const ephemeralAssistant: Message = { id: "assistant-1", role: "assistant", blocks: [], ephemeral: true };
	const emptyAssistant: Message = { id: "assistant-2", role: "assistant", blocks: [] };

	const saved = await engine.setMessages([ephemeralAssistant, emptyAssistant]);

	assert.equal(saved, true);
	assert.equal(storage.saved.length, 1);
	assert.deepEqual(storage.saved[0].messages, [emptyAssistant]);
});

test("plugins can patch request messages and options", async () => {
	let providerMessages: Message[] = [];
	let providerOptions: RequestOptions = {};
	let pluginInputMessageFrozen = true;
	let pluginInputBlocksFrozen = true;
	const pluginEphemeral: Message = {
		id: "plugin-ephemeral",
		role: "assistant",
		blocks: [],
		ephemeral: true,
	};
	const plugin: ChatPlugin = {
		name: "request-shaper",
		beforeSubmit: (params) => {
			assert.equal(params.messages[0].role, "user");
			pluginInputMessageFrozen = Object.isFrozen(params.messages[0]);
			pluginInputBlocksFrozen = Object.isFrozen(params.messages[0].blocks);
			const messages: Message[] = params.messages.map(
				(message): Message => ({
					id: message.id,
					role: message.role,
					blocks: message.blocks.map((block) => ({ ...block })) as Message["blocks"],
					...(message.meta ? { meta: { ...message.meta } as Message["meta"] } : {}),
				}),
			);
			messages[0].blocks.push(fileBlock("plugin-file"));
			return { messages: [...messages, pluginEphemeral], options: { temperature: 0.2 } };
		},
	};
	const provider: ChatProvider = {
		async streamChat(request: ChatStreamRequest, onChange: (changes: ConversationChange[]) => void): Promise<void> {
			providerMessages = request.messages;
			providerOptions = request.options;
			onChange([
				{ type: "block.put", messageId: request.messageId, block: { id: "reply-text", type: "text", text: "ok" } },
			]);
		},
	};
	const engine = new ChatEngine({ provider, storage: new MemoryStorage() });
	engine.registerPlugins([plugin]);
	engine.setRequestDefaults({ options: { model: "base-model" } });

	engine.sendMessage("hello");
	await waitFor(() => engine.state.generatingMessageId === null && providerMessages.length > 0, "plugin stream");

	assert.equal(providerOptions.model, "base-model");
	assert.equal(providerOptions.temperature, 0.2);
	assert.equal(getText(providerMessages[0]), "hello");
	assert.ok(providerMessages[0].blocks.some((block) => block.type === "file" && block.id === "plugin-file"));
	assert.equal(
		providerMessages.some((message) => message.id === pluginEphemeral.id),
		false,
	);
	assert.equal(pluginInputMessageFrozen, false);
	assert.equal(pluginInputBlocksFrozen, false);
	assert.equal(Object.isFrozen(engine.state.messages[0]), false);
	assert.equal(Object.isFrozen(engine.state.messages[0].blocks), false);
});

test("structured providers receive semantic fields separately from passthrough options", async () => {
	let providerRequest: ChatRequest | null = null;
	const defaultTools = [{ type: "function", function: { name: "default_tool" } }];
	const pluginTools = [{ type: "function", function: { name: "plugin_tool" } }];
	const plugin: ChatPlugin = {
		name: "semantic-request-shaper",
		beforeSubmit: (params) => {
			assert.equal(params.instructions, "default instructions");
			assert.deepEqual(params.tools, defaultTools);
			return {
				instructions: "plugin instructions",
				tools: pluginTools,
				options: {
					temperature: 0.2,
				},
			};
		},
	};
	const provider: ChatProvider = {
		async streamChat(request: ChatStreamRequest, onChange: (changes: ConversationChange[]) => void): Promise<void> {
			providerRequest = request;
			onChange([
				{ type: "block.put", messageId: request.messageId, block: { id: "reply-text", type: "text", text: "ok" } },
			]);
		},
	};
	const engine = new ChatEngine({ provider, storage: new MemoryStorage() });
	engine.registerPlugins([plugin]);
	engine.setRequestDefaults({
		instructions: "default instructions",
		tools: defaultTools,
		options: {
			model: "base-model",
			providerFlag: "custom passthrough",
		},
	});

	engine.sendMessage("hello");
	await waitFor(() => engine.state.generatingMessageId === null && providerRequest !== null, "structured request");

	const request = providerRequest as unknown as ChatRequest;
	assert.equal(request.instructions, "plugin instructions");
	assert.deepEqual(request.tools, pluginTools);
	assert.equal(request.options.model, "base-model");
	assert.equal(request.options.temperature, 0.2);
	assert.equal(request.options.providerFlag, "custom passthrough");
	assert.equal(request.messages[0].role, "user");
});

test("plugins can explicitly clear semantic request defaults", async () => {
	let providerRequest: ChatRequest | null = null;
	const defaultTools = [{ type: "function", function: { name: "default_tool" } }];
	const plugin: ChatPlugin = {
		name: "semantic-request-clearer",
		beforeSubmit: (params) => {
			assert.equal(params.instructions, "default instructions");
			assert.deepEqual(params.tools, defaultTools);
			return {
				instructions: undefined,
				tools: undefined,
			};
		},
	};
	const provider: ChatProvider = {
		async streamChat(request: ChatStreamRequest, onChange: (changes: ConversationChange[]) => void): Promise<void> {
			providerRequest = request;
			onChange([
				{ type: "block.put", messageId: request.messageId, block: { id: "reply-text", type: "text", text: "ok" } },
			]);
		},
	};
	const engine = new ChatEngine({ provider, storage: new MemoryStorage() });
	engine.registerPlugins([plugin]);
	engine.setRequestDefaults({
		instructions: "default instructions",
		tools: defaultTools,
	});

	engine.sendMessage("hello");
	await waitFor(() => engine.state.generatingMessageId === null && providerRequest !== null, "structured request");

	const request = providerRequest as unknown as ChatRequest;
	assert.equal(request.instructions, undefined);
	assert.equal(request.tools, undefined);
	assert.equal(request.messages[0].role, "user");
});

test("auto-title bypasses submit hooks and updates session metadata after the first reply", async () => {
	const storage = new MemoryStorage();
	let beforeSubmitCalls = 0;
	let chatOptions: RequestOptions = {};
	let titleOptions: RequestOptions = {};

	const provider: ChatProvider = {
		async streamChat(request: ChatStreamRequest, onChange: (changes: ConversationChange[]) => void): Promise<void> {
			chatOptions = request.options;
			onChange([
				{ type: "block.put", messageId: request.messageId, block: { id: "reply-text", type: "text", text: "answer" } },
			]);
		},
		async generateTitle(request): Promise<string> {
			titleOptions = request.options;
			return "Smart Title";
		},
	};
	const plugin: ChatPlugin = {
		name: "request-shaper",
		beforeSubmit: () => {
			beforeSubmitCalls++;
			return { options: { temperature: 0.2 } };
		},
	};
	const engine = new ChatEngine({ provider, storage });
	engine.registerPlugins([plugin]);
	engine.setRequestDefaults({ options: { model: "base-model" } });

	engine.sendMessage("hello");
	await waitFor(() => storage.metadataUpdates.length === 1, "auto-title metadata update");

	assert.equal(beforeSubmitCalls, 1);
	assert.equal(chatOptions.temperature, 0.2);
	assert.equal(titleOptions.model, "base-model");
	assert.equal(titleOptions.temperature, undefined);
	const sessionId = engine.state.currentSessionId;
	assert.deepEqual(storage.metadataUpdates, [{ id: sessionId, meta: { title: "Smart Title" } }]);
	assert.equal(engine.state.sessions.find((session) => session.id === sessionId)?.title, "Smart Title");
});

test("auto-title merges request defaults with live title options", async () => {
	const storage = new MemoryStorage();
	let titleOptions: RequestOptions = {};
	let titleInstructions: string | undefined;
	const { promise: streamReleased, resolve: releaseStream } = Promise.withResolvers<void>();
	const { promise: streamStartedPromise, resolve: streamStarted } = Promise.withResolvers<void>();
	const provider: ChatProvider = {
		async streamChat(request, onChange): Promise<void> {
			streamStarted();
			await streamReleased;
			onChange([
				{ type: "block.put", messageId: request.messageId, block: { id: "reply-text", type: "text", text: "answer" } },
			]);
		},
		async generateTitle(request): Promise<string> {
			titleOptions = request.options;
			titleInstructions = request.instructions;
			return "Smart Title";
		},
	};
	const engine = new ChatEngine({ provider, storage });
	engine.setRequestDefaults({
		instructions: "chat instructions",
		options: {
			model: "base-model",
			temperature: 0.7,
			max_tokens: 100,
		},
	});
	engine.setTitleOptions({ model: "stale-title-model", max_tokens: 12 });

	engine.sendMessage("hello");
	await streamStartedPromise;
	engine.setTitleOptions({
		model: "title-model",
		max_tokens: undefined,
		providerFlag: "custom title passthrough",
	});
	engine.setTitleInstructions("title instructions");
	releaseStream();
	await waitFor(() => storage.metadataUpdates.length === 1, "auto-title metadata update");

	assert.equal(titleInstructions, "title instructions");
	assert.equal(titleOptions.model, "title-model");
	assert.equal(titleOptions.providerFlag, "custom title passthrough");
	assert.equal(titleOptions.temperature, 0.7);
	assert.equal(titleOptions.max_tokens, 100);
});

test("deleting the active session prevents re-selection and an aborted generation save", async (t) => {
	t.mock.method(console, "error", () => {});
	const calls: string[] = [];
	const storage = new (class extends MemoryStorage {
		override async save(session: ChatSession): Promise<void> {
			calls.push(`save:${session.id}`);
			await super.save(session);
		}

		override async delete(id: string): Promise<void> {
			calls.push(`delete:${id}`);
			await super.delete(id);
		}
	})([
		{
			id: "active-session",
			title: "Active chat",
			updatedAt: 100,
			messages: [],
		},
	]);

	const { promise: streamReleased, resolve: releaseStream } = Promise.withResolvers<void>();

	const { promise: streamStartedPromise, resolve: streamStarted } = Promise.withResolvers<void>();

	const provider: ChatProvider = {
		async streamChat(): Promise<void> {
			streamStarted();
			await streamReleased;
		},
	};

	const engine = new ChatEngine({ provider, storage, initialSessionId: "active-session" });
	await waitFor(() => !engine.state.isLoadingSession, "active session load");

	engine.sendMessage("hello");
	await streamStartedPromise;
	const deletePromise = engine.sessions.delete("active-session");
	await engine.sessions.switch("active-session");
	await deletePromise;

	releaseStream();
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.deepEqual(calls, ["delete:active-session"]);
	assert.equal(storage.saved.length, 0);
	assert.equal(storage.deleted.length, 1);
	assert.notEqual(engine.state.currentSessionId, "active-session");
});

test("session save enqueued behind a pending title update keeps the new title", async () => {
	let releaseMetadata = () => {};
	const metadataGate = new Promise<void>((resolve) => {
		releaseMetadata = resolve;
	});
	const storage = new (class extends MemoryStorage {
		override async updateMetadata(id: string, meta: Partial<ChatSessionMeta>): Promise<void> {
			await metadataGate;
			await super.updateMetadata(id, meta);
		}
	})();

	const engine = new ChatEngine({ provider: replyingProvider("unused"), storage });
	const sessionId = engine.state.currentSessionId;

	// First save creates the session meta with a fallback title.
	await engine.setMessages([textMessage("m1", "user", "first question")]);

	// The title update parks inside storage.updateMetadata while a snapshot
	// save is enqueued behind it.
	const titleUpdate = engine.sessions.updateTitle(sessionId, "Smart Title");
	const snapshotSave = engine.setMessages([
		textMessage("m1", "user", "first question"),
		textMessage("m2", "assistant", "an answer"),
	]);

	releaseMetadata();
	await Promise.all([titleUpdate, snapshotSave]);

	assert.equal(storage.sessions.get(sessionId)?.title, "Smart Title");
	assert.equal(engine.state.sessions.find((s) => s.id === sessionId)?.title, "Smart Title");
});

test("sessions.loadOlderMessages uses an opaque cursor instead of the oldest message id", async () => {
	const older = [textMessage("m1", "user", "first"), textMessage("m2", "assistant", "second")];
	const storage = new (class extends MemoryStorage {
		public olderCalls: { cursor: string; limit: number }[] = [];
		async loadOlderMessages(_id: string, cursor: string, limit: number) {
			this.olderCalls.push({ cursor, limit });
			return { messages: older, hasMore: false };
		}
	})([
		{
			id: "chat-1",
			title: "Chat 1",
			updatedAt: 1,
			messages: [textMessage("msg_db_483", "user", "third")],
			hasMoreMessages: true,
			nextOlderMessagesCursor: "483",
		},
	]);

	const engine = new ChatEngine({ provider: replyingProvider("unused"), storage });
	await engine.sessions.switch("chat-1");

	assert.equal(engine.state.hasMoreMessages, true);
	assert.deepEqual(
		engine.state.messages.map((m) => m.id),
		["msg_db_483"],
	);

	await engine.sessions.loadOlderMessages();

	assert.deepEqual(storage.olderCalls, [{ cursor: "483", limit: 100 }]);
	assert.deepEqual(
		engine.state.messages.map((m) => m.id),
		["m1", "m2", "msg_db_483"],
	);
	assert.equal(engine.state.hasMoreMessages, false);
	assert.equal(engine.state.isLoadingMessages, false);

	// Nothing older remains: further calls are no-ops (storage is not hit again).
	await engine.sessions.loadOlderMessages();
	assert.equal(storage.olderCalls.length, 1);
});

test("incomplete history without a cursor is rejected rather than treated as a complete transcript", async () => {
	const storage = new (class extends MemoryStorage {
		public olderCalls = 0;
		async loadOlderMessages(_id: string, _cursor: string, _limit: number) {
			this.olderCalls++;
			return { messages: [], hasMore: false };
		}
	})([
		{
			id: "chat-1",
			title: "Chat 1",
			updatedAt: 1,
			messages: [textMessage("msg_db_483", "user", "third")],
			hasMoreMessages: true,
		},
	]);

	const engine = new ChatEngine({ provider: replyingProvider("unused"), storage });
	await engine.sessions.switch("chat-1");

	assert.notEqual(engine.state.currentSessionId, "chat-1");
	assert.ok(engine.state.error);
	assert.equal(engine.state.hasMoreMessages, false);
	await engine.sessions.loadOlderMessages();
	assert.equal(storage.olderCalls, 0);
});

test("saving a paginated conversation preserves its unloaded history until all pages are loaded", async (t) => {
	const storage = new (class extends MemoryStorage {
		async loadOlderMessages() {
			return { messages: [textMessage("older", "user", "earlier")], hasMore: false };
		}
	})([
		{
			id: "chat-1",
			title: "Chat",
			updatedAt: 1,
			messages: [textMessage("latest", "user", "latest")],
			hasMoreMessages: true,
			nextOlderMessagesCursor: "before-latest",
		},
	]);
	const engine = new ChatEngine({ provider: replyingProvider("answer"), storage });
	t.after(() => engine.destroy());
	await engine.sessions.switch("chat-1");
	engine.sendMessage("Continue");
	await waitFor(() => storage.saved.length === 1, "partial save");
	assert.equal(storage.saved[0].hasMoreMessages, true);
	assert.equal(storage.saved[0].nextOlderMessagesCursor, "before-latest");
	assert.equal(storage.saved[0].messages[0].id, "latest");
	await engine.sessions.loadOlderMessages();
	engine.sendMessage("Continue again");
	await waitFor(() => storage.saved.length === 2, "complete save");
	assert.equal(storage.saved[1].hasMoreMessages, undefined);
	assert.equal(storage.saved[1].nextOlderMessagesCursor, undefined);
	assert.equal(storage.saved[1].messages[0].id, "older");
});

test("sessions.loadOlderMessages retains the cursor on a malformed page and follows valid cursors", async () => {
	const pages = [
		{ messages: [textMessage("invalid", "assistant", "invalid page")], hasMore: true },
		{ messages: [textMessage("m2", "assistant", "second")], hasMore: true, nextOlderMessagesCursor: "" },
		{ messages: [textMessage("m1", "user", "first")], hasMore: false },
	];
	const storage = new (class extends MemoryStorage {
		public olderCalls: string[] = [];
		async loadOlderMessages(_id: string, cursor: string, _limit: number) {
			this.olderCalls.push(cursor);
			return pages.shift() ?? { messages: [], hasMore: false };
		}
	})([
		{
			id: "chat-1",
			title: "Chat 1",
			updatedAt: 1,
			messages: [textMessage("m3", "user", "third")],
			hasMoreMessages: true,
			nextOlderMessagesCursor: "300",
		},
	]);

	const engine = new ChatEngine({ provider: replyingProvider("unused"), storage });
	await engine.sessions.switch("chat-1");

	await engine.sessions.loadOlderMessages();
	assert.equal(engine.state.hasMoreMessages, true);
	assert.equal(engine.state.isLoadingMessages, false);
	assert.deepEqual(
		engine.state.messages.map((message) => message.id),
		["m3"],
	);
	await engine.sessions.loadOlderMessages();
	assert.equal(engine.state.hasMoreMessages, true);
	await engine.sessions.loadOlderMessages();

	assert.deepEqual(storage.olderCalls, ["300", "300", ""]);
	assert.deepEqual(
		engine.state.messages.map((m) => m.id),
		["m1", "m2", "m3"],
	);
	assert.equal(engine.state.hasMoreMessages, false);
});

test("late history pages cannot change a replacement snapshot or another page's loading state", async () => {
	type Page = { messages: Message[]; hasMore: boolean };
	const pending: ((page: Page) => void)[] = [];
	const storage = new (class extends MemoryStorage {
		async loadOlderMessages() {
			return new Promise<Page>((resolve) => pending.push(resolve));
		}
	})(
		["a", "b"].map((id) => ({
			id,
			title: id,
			updatedAt: 1,
			messages: [textMessage(id, "user", id)],
			hasMoreMessages: true,
			nextOlderMessagesCursor: "page",
		})),
	);
	const engine = new ChatEngine({ provider: replyingProvider("unused"), storage });
	await engine.sessions.switch("a");
	const oldPage = engine.sessions.loadOlderMessages();
	await engine.sessions.switch("b");
	await engine.sessions.switch("a");
	const newPage = engine.sessions.loadOlderMessages();
	pending[0]({ messages: [textMessage("stale", "user", "stale")], hasMore: false });
	await oldPage;
	assert.equal(engine.state.isLoadingMessages, true);
	assert.deepEqual(
		engine.state.messages.map((message) => message.id),
		["a"],
	);
	pending[1]({ messages: [textMessage("older", "user", "older")], hasMore: false });
	await newPage;
	assert.equal(engine.state.isLoadingMessages, false);
	assert.deepEqual(
		engine.state.messages.map((message) => message.id),
		["older", "a"],
	);

	await engine.sessions.switch("b");
	const replacedPage = engine.sessions.loadOlderMessages();
	await engine.setMessages([textMessage("replacement", "user", "replacement")]);
	pending[2]({ messages: [textMessage("discarded", "user", "discarded")], hasMore: false });
	await replacedPage;
	assert.deepEqual(
		engine.state.messages.map((message) => message.id),
		["replacement"],
	);
	assert.equal(engine.state.isLoadingMessages, false);
	assert.equal(engine.state.hasMoreMessages, false);
	await engine.destroy();
});
