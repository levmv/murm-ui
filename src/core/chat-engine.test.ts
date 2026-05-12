import * as assert from "node:assert/strict";
import { test } from "node:test";
import { ChatEngine } from "./chat-engine";
import type {
	ChatPlugin,
	ChatProvider,
	ChatRequest,
	ChatSession,
	ChatSessionMeta,
	ChatStorage,
	ContentBlock,
	Message,
	PaginatedSessions,
	RequestOptions,
	StreamEvent,
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
		async streamChat(_request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
			onEvent({ type: "text_delta", messageId: "provider-message", blockId: "reply-text", delta: reply });
			onEvent({ type: "finish", reason: "stop" });
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

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
	engine.sendMessage("hello");
	await waitFor(() => engine.state.generatingMessageId === null && storage.saved.length === 1, "stream finalization");

	const state = engine.state;
	assert.equal(state.messages.length, 2);
	assert.equal(state.messages[0].role, "user");
	assert.equal(getText(state.messages[0]), "hello");
	assert.equal(state.messages[1].role, "assistant");
	assert.equal(getText(state.messages[1]), "hello back");
	assert.equal(state.messages[1].ephemeral, undefined);
	assert.equal(storage.saved[0].title, "hello");
	assert.equal(state.sessions[0].id, state.currentSessionId);
});

test("sendMessage streams multiple assistant messages from one provider run", async () => {
	const storage = new MemoryStorage();
	const provider: ChatProvider = {
		async streamChat(_request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
			onEvent({
				type: "message_start",
				message: { id: "assistant-1", role: "assistant", blocks: [] },
			});
			onEvent({ type: "text_delta", messageId: "assistant-1", blockId: "text-1", delta: "first" });
			onEvent({
				type: "message_start",
				message: { id: "assistant-2", role: "assistant", blocks: [] },
			});
			onEvent({ type: "text_delta", messageId: "assistant-2", blockId: "text-2", delta: "second" });
			onEvent({ type: "finish", reason: "stop" });
		},
	};
	const engine = new ChatEngine({ provider, storage });

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
	engine.sendMessage("hello");
	await waitFor(() => engine.state.generatingMessageId === null && storage.saved.length === 1, "stream finalization");

	const state = engine.state;
	assert.equal(state.messages.length, 3);
	assert.equal(state.messages[1].id, "assistant-1");
	assert.equal(getText(state.messages[1]), "first");
	assert.equal(state.messages[2].id, "assistant-2");
	assert.equal(getText(state.messages[2]), "second");
	assert.equal(storage.saved[0].messages.length, 3);
});

test("generation save completion does not disturb a session switched during persistence", async () => {
	let releaseSave!: () => void;
	const saveReleased = new Promise<void>((resolve) => {
		releaseSave = resolve;
	});

	let saveStarted!: () => void;
	const saveStartedPromise = new Promise<void>((resolve) => {
		saveStarted = resolve;
	});

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

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
	engine.sendMessage("hello");
	await saveStartedPromise;
	await waitFor(() => engine.state.generatingMessageId === null, "generation indicator cleared");

	await engine.sessions.switch(otherSession.id);
	assert.equal(engine.state.currentSessionId, otherSession.id);
	assert.equal(getText(engine.state.messages[0]), "other question");

	releaseSave();
	await waitFor(() => storage.saved.length === 1, "delayed save completion");

	assert.equal(engine.state.currentSessionId, otherSession.id);
	assert.equal(getText(engine.state.messages[0]), "other question");
	assert.equal(storage.saved[0].id !== otherSession.id, true);
	assert.equal(
		engine.state.sessions.some((session) => session.id === storage.saved[0].id),
		true,
	);
});

test("overlapping same-session saves are persisted in request order", async () => {
	let releaseFirstSave!: () => void;
	const firstSaveReleased = new Promise<void>((resolve) => {
		releaseFirstSave = resolve;
	});

	let firstSaveStarted!: () => void;
	const firstSaveStartedPromise = new Promise<void>((resolve) => {
		firstSaveStarted = resolve;
	});

	const storage = new (class extends MemoryStorage {
		private saveCount = 0;

		override async save(session: ChatSession): Promise<void> {
			this.saveCount++;
			if (this.saveCount === 1) {
				firstSaveStarted();
				await firstSaveReleased;
			}
			await super.save(session);
		}
	})();

	let replyCount = 0;
	const provider: ChatProvider = {
		async streamChat(_request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
			replyCount++;
			onEvent({
				type: "text_delta",
				messageId: "provider-message",
				blockId: `reply-${replyCount}`,
				delta: replyCount === 1 ? "first reply" : "second reply",
			});
			onEvent({ type: "finish", reason: "stop" });
		},
	};
	const engine = new ChatEngine({ provider, storage });

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
	engine.sendMessage("first");
	await firstSaveStartedPromise;
	await waitFor(() => engine.state.generatingMessageId === null, "first generation indicator cleared");

	assert.equal(engine.sendMessage("second"), true);
	await waitFor(() => replyCount === 2 && engine.state.generatingMessageId === null, "second generation completed");

	assert.equal(storage.saved.length, 0);
	releaseFirstSave();
	await waitFor(() => storage.saved.length === 2, "ordered save completion");

	const finalSaved = storage.saved[1];
	assert.equal(getText(finalSaved.messages[0]), "first");
	assert.equal(getText(finalSaved.messages[1]), "first reply");
	assert.equal(getText(finalSaved.messages[2]), "second");
	assert.equal(getText(finalSaved.messages[3]), "second reply");
	assert.deepEqual(storage.sessions.get(finalSaved.id)?.messages, finalSaved.messages);
});

test("deleting a session prevents pending save completions from reinserting it", async () => {
	let releaseSave!: () => void;
	const saveReleased = new Promise<void>((resolve) => {
		releaseSave = resolve;
	});

	let saveStarted!: () => void;
	const saveStartedPromise = new Promise<void>((resolve) => {
		saveStarted = resolve;
	});

	const storage = new (class extends MemoryStorage {
		override async save(session: ChatSession): Promise<void> {
			saveStarted();
			await saveReleased;
			await super.save(session);
		}
	})();
	const engine = new ChatEngine({ provider: replyingProvider("hello back"), storage });

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
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

test("auto-title completion is scoped to the generated session after switching away", async () => {
	let releaseSave!: () => void;
	const saveReleased = new Promise<void>((resolve) => {
		releaseSave = resolve;
	});

	let saveStarted!: () => void;
	const saveStartedPromise = new Promise<void>((resolve) => {
		saveStarted = resolve;
	});

	let titleStarted!: () => void;
	const titleStartedPromise = new Promise<void>((resolve) => {
		titleStarted = resolve;
	});

	let releaseTitle!: () => void;
	const titleReleased = new Promise<void>((resolve) => {
		releaseTitle = resolve;
	});

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
		async streamChat(_request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
			onEvent({ type: "text_delta", messageId: "provider-message", blockId: "reply-text", delta: "answer" });
			onEvent({ type: "finish", reason: "stop" });
		},
		async generateTitle(): Promise<string> {
			titleStarted();
			await titleReleased;
			return "Smart Title";
		},
	};
	const engine = new ChatEngine({ provider, storage });

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
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
	let titleStarted!: () => void;
	const titleStartedPromise = new Promise<void>((resolve) => {
		titleStarted = resolve;
	});

	let releaseTitle!: () => void;
	const titleReleased = new Promise<void>((resolve) => {
		releaseTitle = resolve;
	});

	const storage = new MemoryStorage();
	const provider: ChatProvider = {
		async streamChat(_request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
			onEvent({ type: "text_delta", messageId: "provider-message", blockId: "reply-text", delta: "answer" });
			onEvent({ type: "finish", reason: "stop" });
		},
		async generateTitle(): Promise<string> {
			titleStarted();
			await titleReleased;
			return "Smart Title";
		},
	};
	const engine = new ChatEngine({ provider, storage });

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
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

test("destroy aborts pending auto-title and ignores late completion", async () => {
	let titleSignal: AbortSignal | null = null;
	let titleStarted!: () => void;
	const titleStartedPromise = new Promise<void>((resolve) => {
		titleStarted = resolve;
	});

	let releaseTitle!: () => void;
	const titleReleased = new Promise<void>((resolve) => {
		releaseTitle = resolve;
	});

	const storage = new MemoryStorage();
	const provider: ChatProvider = {
		async streamChat(_request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
			onEvent({ type: "text_delta", messageId: "provider-message", blockId: "reply-text", delta: "answer" });
			onEvent({ type: "finish", reason: "stop" });
		},
		async generateTitle(request): Promise<string> {
			titleSignal = request.signal;
			titleStarted();
			await titleReleased;
			return "Late Title";
		},
	};
	const engine = new ChatEngine({ provider, storage });

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
	engine.sendMessage("hello");
	await titleStartedPromise;

	await engine.destroy();
	assert.ok(titleSignal);
	assert.equal((titleSignal as AbortSignal).aborted, true);

	releaseTitle();
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.deepEqual(storage.metadataUpdates, []);
});

test("destroy aborts pending auto-title before waiting on active generation shutdown", async () => {
	let titleSignal: AbortSignal | null = null;
	let titleStarted!: () => void;
	const titleStartedPromise = new Promise<void>((resolve) => {
		titleStarted = resolve;
	});

	let releaseTitle!: () => void;
	const titleReleased = new Promise<void>((resolve) => {
		releaseTitle = resolve;
	});

	let secondStreamStarted!: () => void;
	const secondStreamStartedPromise = new Promise<void>((resolve) => {
		secondStreamStarted = resolve;
	});

	let releaseSecondStream!: () => void;
	const secondStreamReleased = new Promise<void>((resolve) => {
		releaseSecondStream = resolve;
	});

	const storage = new MemoryStorage();
	let streamCalls = 0;
	const provider: ChatProvider = {
		async streamChat(request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
			streamCalls++;
			if (streamCalls === 1) {
				onEvent({ type: "text_delta", messageId: "provider-message", blockId: "first-reply", delta: "answer" });
				onEvent({ type: "finish", reason: "stop" });
				return;
			}

			secondStreamStarted();
			await secondStreamReleased;
			if (request.signal.aborted) {
				onEvent({ type: "finish", reason: "aborted" });
			}
		},
		async generateTitle(request): Promise<string> {
			titleSignal = request.signal;
			titleStarted();
			await titleReleased;
			return "Late Title";
		},
	};
	const engine = new ChatEngine({ provider, storage });

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
	engine.sendMessage("first");
	await titleStartedPromise;

	assert.equal(engine.sendMessage("second"), true);
	await secondStreamStartedPromise;

	const destroyPromise = engine.destroy();
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.ok(titleSignal);
	assert.equal((titleSignal as AbortSignal).aborted, true);

	releaseSecondStream();
	releaseTitle();
	await destroyPromise;

	assert.deepEqual(storage.metadataUpdates, []);
});

test("sendMessage preserves encrypted reasoning as hidden metadata", async () => {
	const storage = new MemoryStorage();
	const engine = new ChatEngine({
		provider: {
			async streamChat(_request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
				onEvent({
					type: "reasoning_delta",
					messageId: "provider-message",
					blockId: "hidden-reasoning",
					delta: "ciphertext",
					encrypted: true,
				});
				onEvent({ type: "finish", reason: "stop" });
			},
		},
		storage,
	});

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
	engine.sendMessage("hello");
	await waitFor(() => engine.state.generatingMessageId === null && storage.saved.length === 1, "stream finalization");

	const reasoningBlock = engine.state.messages[1].blocks.find(
		(block): block is Extract<ContentBlock, { type: "reasoning" }> => block.type === "reasoning",
	);
	assert.ok(reasoningBlock);
	assert.equal(reasoningBlock.encrypted, true);
	assert.equal(reasoningBlock.text, "");
	assert.equal(reasoningBlock.encryptedText, "ciphertext");
});

test("sendMessage skips empty encrypted reasoning payloads", async () => {
	const storage = new MemoryStorage();
	const engine = new ChatEngine({
		provider: {
			async streamChat(_request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
				onEvent({
					type: "reasoning_delta",
					messageId: "provider-message",
					blockId: "hidden-reasoning",
					delta: "",
					encrypted: true,
				});
				onEvent({ type: "finish", reason: "stop" });
			},
		},
		storage,
	});

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
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

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
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

test("failed generation marks streaming tool calls as errored", async () => {
	const storage = new MemoryStorage();
	const engine = new ChatEngine({
		provider: {
			async streamChat(_request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
				onEvent({
					type: "tool_call_start",
					messageId: "provider-message",
					block: {
						id: "tool-1",
						type: "tool_call",
						toolCallId: "call-1",
						name: "lookup_weather",
						argsText: '{"q":"weather"}',
						status: "streaming",
					},
				});
				throw new Error("Provider failed");
			},
		},
		storage,
	});

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
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
	let releaseLoad!: () => void;
	const loadReleased = new Promise<void>((resolve) => {
		releaseLoad = resolve;
	});

	let loadStarted!: () => void;
	const loadStartedPromise = new Promise<void>((resolve) => {
		loadStarted = resolve;
	});

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
			async streamChat(_request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
				providerCalls++;
				onEvent({ type: "text_delta", messageId: "provider-message", blockId: "reply-text", delta: "ok" });
				onEvent({ type: "finish", reason: "stop" });
			},
		},
		storage,
	});
	void engine.sessions.loadHistory();
	engine.registerPlugins([
		{
			name: "submit-spy",
			onUserSubmit: () => {
				pluginCalled = true;
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

	let releaseLoadOne!: () => void;
	const loadOneReleased = new Promise<void>((resolve) => {
		releaseLoadOne = resolve;
	});

	let loadOneStarted!: () => void;
	const loadOneStartedPromise = new Promise<void>((resolve) => {
		loadOneStarted = resolve;
	});

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
			onUserSubmit: () => {
				pluginCalled = true;
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
	let releaseBeforeSubmit!: () => void;
	const beforeSubmitReleased = new Promise<void>((resolve) => {
		releaseBeforeSubmit = resolve;
	});

	let beforeSubmitStarted!: () => void;
	const beforeSubmitStartedPromise = new Promise<void>((resolve) => {
		beforeSubmitStarted = resolve;
	});

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

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
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

test("stopping after streamed content keeps the partial assistant message", async () => {
	const storage = new MemoryStorage();
	let releaseStream!: () => void;
	const streamReleased = new Promise<void>((resolve) => {
		releaseStream = resolve;
	});

	let streamStarted!: () => void;
	const streamStartedPromise = new Promise<void>((resolve) => {
		streamStarted = resolve;
	});

	const provider: ChatProvider = {
		async streamChat(request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
			onEvent({ type: "text_delta", messageId: "provider-message", blockId: "partial-text", delta: "partial" });
			streamStarted();
			await streamReleased;
			if (request.signal.aborted) {
				onEvent({ type: "finish", reason: "aborted" });
			}
		},
	};

	const engine = new ChatEngine({ provider, storage });
	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");

	engine.sendMessage("hello");
	await streamStartedPromise;
	await engine.stopGeneration();
	releaseStream();

	await waitFor(() => engine.state.generatingMessageId === null && storage.saved.length === 1, "abort finalization");

	const state = engine.state;
	assert.equal(state.messages.length, 2);
	assert.equal(state.messages[1].role, "assistant");
	assert.equal(getText(state.messages[1]), "partial");
});

test("editAndResubmit truncates later history while preserving non-text blocks", async () => {
	let providerMessages: Message[] = [];
	const provider: ChatProvider = {
		async streamChat(request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
			providerMessages = request.messages;
			onEvent({ type: "text_delta", messageId: "provider-message", blockId: "edited-reply", delta: "edited response" });
			onEvent({ type: "finish", reason: "stop" });
		},
	};
	const storage = new MemoryStorage();
	const engine = new ChatEngine({ provider, storage });
	const userMessage: Message = {
		id: "user-1",
		role: "user",
		blocks: [{ id: "old-text", type: "text", text: "old text" }, fileBlock()],
	};

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
	await engine.setMessages([userMessage, textMessage("assistant-1", "assistant", "old response")]);
	const accepted = engine.editAndResubmit("user-1", "new text");
	await waitFor(() => engine.state.generatingMessageId === null && providerMessages.length > 0, "edited stream");

	assert.equal(accepted, true);
	assert.equal(providerMessages.length, 1);
	assert.equal(getText(providerMessages[0]), "new text");
	assert.ok(providerMessages[0].blocks.some((block) => block.type === "file" && block.name === "notes.txt"));

	const state = engine.state;
	assert.equal(state.messages.length, 2);
	assert.equal(state.messages[0].id, "user-1");
	assert.equal(getText(state.messages[0]), "new text");
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

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
	await engine.setMessages([userMessage]);
	const accepted = engine.editAndResubmit("user-1", "");
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(accepted, false);
	assert.equal(providerCalled, false);
	assert.equal(engine.state.generatingMessageId, null);
	assert.deepEqual(engine.state.messages, [userMessage]);
});

test("tool call deltas update streamed tool names", async () => {
	const storage = new MemoryStorage();
	const engine = new ChatEngine({
		provider: {
			async streamChat(_request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
				onEvent({
					type: "tool_call_start",
					messageId: "assistant-1",
					block: {
						id: "tool-1",
						type: "tool_call",
						toolCallId: "call-1",
						name: "",
						argsText: "",
						status: "streaming",
					},
				});
				onEvent({
					type: "tool_call_delta",
					messageId: "assistant-1",
					blockId: "tool-1",
					name: "lookup_weather",
					argsDelta: '{"q":"weather"}',
				});
				onEvent({ type: "finish", reason: "tool_use" });
			},
		},
		storage,
	});

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
	assert.equal(engine.sendMessage("hello"), true);
	await waitFor(() => engine.state.generatingMessageId === null && storage.saved.length === 1, "tool stream");

	const toolCall = engine.state.messages[1].blocks.find(
		(block): block is Extract<ContentBlock, { type: "tool_call" }> => block.type === "tool_call",
	);

	assert.ok(toolCall);
	assert.equal(toolCall.name, "lookup_weather");
	assert.equal(toolCall.argsText, '{"q":"weather"}');
	assert.equal(toolCall.status, "complete");
});

test("sendMessage catches plugin onUserSubmit failures and continues", async () => {
	let providerMessages: Message[] = [];
	const storage = new MemoryStorage();
	const engine = new ChatEngine({
		provider: {
			async streamChat(request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
				providerMessages = request.messages;
				onEvent({ type: "text_delta", messageId: "provider-message", blockId: "reply-text", delta: "ok" });
				onEvent({ type: "finish", reason: "stop" });
			},
		},
		storage,
	});
	const originalConsoleError = console.error;
	const loggedErrors: unknown[][] = [];
	console.error = (...args: unknown[]) => {
		loggedErrors.push(args);
	};

	try {
		engine.registerPlugins([
			{
				name: "broken-submit",
				onUserSubmit: () => {
					throw new Error("plugin failed");
				},
			},
			{
				name: "still-runs",
				onUserSubmit: (message) => {
					message.meta = { pluginContinued: true };
				},
			},
		]);

		await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
		assert.equal(engine.sendMessage("hello"), true);
		await waitFor(
			() => engine.state.generatingMessageId === null && storage.saved.length === 1,
			"plugin failure stream",
		);
	} finally {
		console.error = originalConsoleError;
	}

	assert.equal(loggedErrors.length, 1);
	assert.match(String(loggedErrors[0][0]), /broken-submit/);
	assert.equal(providerMessages[0].meta?.pluginContinued, true);
	assert.equal(getText(providerMessages[0]), "hello");
});

test("setMessages can persist an empty current session", async () => {
	const storage = new MemoryStorage();
	const engine = new ChatEngine({ provider: replyingProvider("unused"), storage });

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");

	const saved = await engine.setMessages([]);

	assert.equal(saved, true);
	assert.equal(storage.saved.length, 1);
	assert.deepEqual(storage.saved[0].messages, []);
	assert.equal(storage.saved[0].title, "Empty Chat");
	assert.equal(engine.state.sessions[0].id, engine.state.currentSessionId);
	assert.equal(engine.state.sessions[0].title, "Empty Chat");
});

test("setMessages omits ephemeral messages when saving", async () => {
	const storage = new MemoryStorage();
	const engine = new ChatEngine({ provider: replyingProvider("unused"), storage });
	const ephemeralAssistant: Message = { id: "assistant-1", role: "assistant", blocks: [], ephemeral: true };

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");

	const saved = await engine.setMessages([ephemeralAssistant]);

	assert.equal(saved, true);
	assert.equal(storage.saved.length, 1);
	assert.deepEqual(storage.saved[0].messages, []);
});

test("setMessages preserves non-ephemeral empty assistant messages when saving", async () => {
	const storage = new MemoryStorage();
	const engine = new ChatEngine({ provider: replyingProvider("unused"), storage });
	const emptyAssistant: Message = { id: "assistant-1", role: "assistant", blocks: [] };

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");

	const saved = await engine.setMessages([emptyAssistant]);

	assert.equal(saved, true);
	assert.equal(storage.saved.length, 1);
	assert.deepEqual(storage.saved[0].messages, [emptyAssistant]);
});

test("plugins can add user message data and patch request options", async () => {
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
		onUserSubmit: (message) => {
			message.blocks.push(fileBlock("plugin-file"));
		},
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
			return { messages: [...messages, pluginEphemeral], options: { temperature: 0.2 } };
		},
	};
	const provider: ChatProvider = {
		async streamChat(request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
			providerMessages = request.messages;
			providerOptions = request.options;
			onEvent({ type: "text_delta", messageId: "provider-message", blockId: "reply-text", delta: "ok" });
			onEvent({ type: "finish", reason: "stop" });
		},
	};
	const engine = new ChatEngine({ provider, storage: new MemoryStorage() });
	engine.registerPlugins([plugin]);
	engine.setRequestDefaults({ options: { model: "base-model" } });

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
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
		async streamChat(request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
			providerRequest = request;
			onEvent({ type: "text_delta", messageId: "provider-message", blockId: "reply-text", delta: "ok" });
			onEvent({ type: "finish", reason: "stop" });
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

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
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

test("auto-title updates session metadata after the first assistant reply", async () => {
	const storage = new MemoryStorage();
	const provider: ChatProvider = {
		async streamChat(_request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
			onEvent({ type: "text_delta", messageId: "provider-message", blockId: "reply-text", delta: "answer" });
			onEvent({ type: "finish", reason: "stop" });
		},
		async generateTitle(): Promise<string> {
			return "Smart Title";
		},
	};
	const engine = new ChatEngine({ provider, storage });

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
	engine.sendMessage("hello");
	await waitFor(() => storage.metadataUpdates.length === 1, "auto-title metadata update");

	const sessionId = engine.state.currentSessionId;
	assert.deepEqual(storage.metadataUpdates, [{ id: sessionId, meta: { title: "Smart Title" } }]);
	assert.equal(engine.state.sessions.find((session) => session.id === sessionId)?.title, "Smart Title");
});

test("auto-title bypasses beforeSubmit hooks", async () => {
	const storage = new MemoryStorage();
	let beforeSubmitCalls = 0;
	let chatOptions: RequestOptions = {};
	let titleOptions: RequestOptions = {};

	const provider: ChatProvider = {
		async streamChat(request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
			chatOptions = request.options;
			onEvent({ type: "text_delta", messageId: "provider-message", blockId: "reply-text", delta: "answer" });
			onEvent({ type: "finish", reason: "stop" });
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

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
	engine.sendMessage("hello");
	await waitFor(() => storage.metadataUpdates.length === 1, "auto-title metadata update");

	assert.equal(beforeSubmitCalls, 1);
	assert.equal(chatOptions.temperature, 0.2);
	assert.equal(titleOptions.model, "base-model");
	assert.equal(titleOptions.temperature, undefined);
});

test("auto-title merges request defaults with live title options", async () => {
	const storage = new MemoryStorage();
	let titleOptions: RequestOptions = {};
	let titleInstructions: string | undefined;
	let releaseStream!: () => void;
	const streamReleased = new Promise<void>((resolve) => {
		releaseStream = resolve;
	});
	let streamStarted!: () => void;
	const streamStartedPromise = new Promise<void>((resolve) => {
		streamStarted = resolve;
	});
	const provider: ChatProvider = {
		async streamChat(_request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
			streamStarted();
			await streamReleased;
			onEvent({ type: "text_delta", messageId: "provider-message", blockId: "reply-text", delta: "answer" });
			onEvent({ type: "finish", reason: "stop" });
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

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
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

test("deleting the active session lets deletion win over the aborted generation save", async () => {
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

	let releaseStream!: () => void;
	const streamReleased = new Promise<void>((resolve) => {
		releaseStream = resolve;
	});

	let streamStarted!: () => void;
	const streamStartedPromise = new Promise<void>((resolve) => {
		streamStarted = resolve;
	});

	const provider: ChatProvider = {
		async streamChat(request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
			streamStarted();
			await streamReleased;
			if (request.signal.aborted) {
				onEvent({ type: "finish", reason: "aborted" });
			}
		},
	};

	const engine = new ChatEngine({ provider, storage, initialSessionId: "active-session" });
	await waitFor(() => !engine.state.isLoadingSession, "active session load");

	engine.sendMessage("hello");
	await streamStartedPromise;
	const deletePromise = engine.sessions.delete("active-session");
	await waitFor(() => engine.state.currentSessionId !== "active-session", "active delete local navigation");
	await deletePromise;

	releaseStream();
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.deepEqual(calls, ["delete:active-session"]);
	assert.equal(storage.saved.length, 0);
	assert.equal(storage.deleted.length, 1);
	assert.notEqual(engine.state.currentSessionId, "active-session");
});
