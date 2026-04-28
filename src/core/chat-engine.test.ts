import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatEngine } from "./chat-engine";
import type {
	ChatPlugin,
	ChatProvider,
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
			this.metas.push({ id: session.id, title: session.title, updatedAt: session.updatedAt });
		}
	}

	async loadSessions(limit: number, cursor?: { updatedAt: number; id: string }): Promise<PaginatedSessions> {
		let metas = [...this.metas].sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));

		if (cursor) {
			const cursorIndex = metas.findIndex(
				(session) => session.updatedAt === cursor.updatedAt && session.id === cursor.id,
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

		const meta = { id: session.id, title: session.title, updatedAt: session.updatedAt };
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
		async streamChat(
			_messages: Message[],
			_options: RequestOptions,
			_signal: AbortSignal,
			onEvent: (event: StreamEvent) => void,
		): Promise<void> {
			onEvent({ type: "text_delta", messageId: "provider-message", blockId: "reply-text", delta: reply });
			onEvent({ type: "finish", reason: "stop" });
		},
	};
}

test("loadSessionHistory lists stored sessions while a clean URL starts a blank chat", async () => {
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

	void engine.loadSessionHistory();
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

	void engine.loadSessionHistory();
	await waitFor(() => !engine.state.isLoadingSessions, "deep-linked sidebar load");
	assert.deepEqual(
		engine.state.sessions.map((session) => session.id),
		["deep-linked", "listed"],
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

	await engine.switchSession("missing-chat");

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
		void engine.loadSessionHistory();

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
	assert.equal(storage.saved[0].title, "hello");
	assert.equal(state.sessions[0].id, state.currentSessionId);
});

test("sendMessage preserves encrypted reasoning as hidden metadata", async () => {
	const storage = new MemoryStorage();
	const engine = new ChatEngine({
		provider: {
			async streamChat(_messages, _options, _signal, onEvent): Promise<void> {
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
			async streamChat(_messages, _options, _signal, onEvent): Promise<void> {
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
	assert.deepEqual(state.error, { message: "Provider failed", id: state.messages[1].id });
	assert.deepEqual(storage.saved[0].messages, [state.messages[0]]);
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
		override async loadSessions(limit: number, cursor?: { updatedAt: number; id: string }): Promise<PaginatedSessions> {
			loadStarted();
			await loadReleased;
			return super.loadSessions(limit, cursor);
		}
	})();

	let pluginCalled = false;
	let providerCalls = 0;

	const engine = new ChatEngine({
		provider: {
			async streamChat(_messages, _options, _signal, onEvent): Promise<void> {
				providerCalls++;
				onEvent({ type: "text_delta", messageId: "provider-message", blockId: "reply-text", delta: "ok" });
				onEvent({ type: "finish", reason: "stop" });
			},
		},
		storage,
	});
	void engine.loadSessionHistory();
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
		async streamChat(
			_messages: Message[],
			_options: RequestOptions,
			_signal: AbortSignal,
			_onEvent: (event: StreamEvent) => void,
		): Promise<void> {
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
		async streamChat(
			_messages: Message[],
			_options: RequestOptions,
			signal: AbortSignal,
			onEvent: (event: StreamEvent) => void,
		): Promise<void> {
			onEvent({ type: "text_delta", messageId: "provider-message", blockId: "partial-text", delta: "partial" });
			streamStarted();
			await streamReleased;
			if (signal.aborted) {
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
		async streamChat(
			messages: Message[],
			_options: RequestOptions,
			_signal: AbortSignal,
			onEvent: (event: StreamEvent) => void,
		): Promise<void> {
			providerMessages = messages;
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
	engine.editAndResubmit("user-1", "new text");
	await waitFor(() => engine.state.generatingMessageId === null && providerMessages.length > 0, "edited stream");

	assert.equal(providerMessages.length, 1);
	assert.equal(getText(providerMessages[0]), "new text");
	assert.ok(providerMessages[0].blocks.some((block) => block.type === "file" && block.name === "notes.txt"));

	const state = engine.state;
	assert.equal(state.messages.length, 2);
	assert.equal(state.messages[0].id, "user-1");
	assert.equal(getText(state.messages[0]), "new text");
	assert.equal(getText(state.messages[1]), "edited response");
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

test("setMessages omits empty assistant messages when saving", async () => {
	const storage = new MemoryStorage();
	const engine = new ChatEngine({ provider: replyingProvider("unused"), storage });
	const emptyAssistant: Message = { id: "assistant-1", role: "assistant", blocks: [] };

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");

	const saved = await engine.setMessages([emptyAssistant]);

	assert.equal(saved, true);
	assert.equal(storage.saved.length, 1);
	assert.deepEqual(storage.saved[0].messages, []);
});

test("plugins can add user message data and patch request options", async () => {
	let providerMessages: Message[] = [];
	let providerOptions: RequestOptions = {};
	let pluginInputMessageFrozen = true;
	let pluginInputBlocksFrozen = true;
	const plugin: ChatPlugin = {
		name: "request-shaper",
		onUserSubmit: (message) => {
			message.blocks.push(fileBlock("plugin-file"));
		},
		beforeSubmit: (params) => {
			assert.equal(params.messages[0].role, "user");
			pluginInputMessageFrozen = Object.isFrozen(params.messages[0]);
			pluginInputBlocksFrozen = Object.isFrozen(params.messages[0].blocks);
			return { options: { temperature: 0.2 } };
		},
	};
	const provider: ChatProvider = {
		async streamChat(
			messages: Message[],
			options: RequestOptions,
			_signal: AbortSignal,
			onEvent: (event: StreamEvent) => void,
		): Promise<void> {
			providerMessages = messages;
			providerOptions = options;
			onEvent({ type: "text_delta", messageId: "provider-message", blockId: "reply-text", delta: "ok" });
			onEvent({ type: "finish", reason: "stop" });
		},
	};
	const engine = new ChatEngine({ provider, storage: new MemoryStorage() });
	engine.registerPlugins([plugin]);
	engine.setRequestDefaults({ model: "base-model" });

	await waitFor(() => !engine.state.isLoadingSession, "empty initial load");
	engine.sendMessage("hello");
	await waitFor(() => engine.state.generatingMessageId === null && providerMessages.length > 0, "plugin stream");

	assert.equal(providerOptions.model, "base-model");
	assert.equal(providerOptions.temperature, 0.2);
	assert.equal(getText(providerMessages[0]), "hello");
	assert.ok(providerMessages[0].blocks.some((block) => block.type === "file" && block.id === "plugin-file"));
	assert.equal(pluginInputMessageFrozen, false);
	assert.equal(pluginInputBlocksFrozen, false);
	assert.equal(Object.isFrozen(engine.state.messages[0]), false);
	assert.equal(Object.isFrozen(engine.state.messages[0].blocks), false);
});

test("auto-title updates session metadata after the first assistant reply", async () => {
	const storage = new MemoryStorage();
	const provider: ChatProvider = {
		async streamChat(
			_messages: Message[],
			_options: RequestOptions,
			_signal: AbortSignal,
			onEvent: (event: StreamEvent) => void,
		): Promise<void> {
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

test("deleting the active session stops generation before deleting storage", async () => {
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
		async streamChat(
			_messages: Message[],
			_options: RequestOptions,
			signal: AbortSignal,
			onEvent: (event: StreamEvent) => void,
		): Promise<void> {
			streamStarted();
			await streamReleased;
			if (signal.aborted) {
				onEvent({ type: "finish", reason: "aborted" });
			}
		},
	};

	const engine = new ChatEngine({ provider, storage, initialSessionId: "active-session" });
	await waitFor(() => !engine.state.isLoadingSession, "active session load");

	engine.sendMessage("hello");
	await streamStartedPromise;
	await engine.deleteSession("active-session");

	releaseStream();
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.deepEqual(calls, ["save:active-session", "delete:active-session"]);
	assert.equal(storage.saved.length, 1);
	assert.equal(storage.deleted.length, 1);
	assert.notEqual(engine.state.currentSessionId, "active-session");
});
