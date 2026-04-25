import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatEngine } from "./chat-engine";
import type {
	ChatPlugin,
	ChatProvider,
	ChatSession,
	ChatSessionMeta,
	ChatStorage,
	Message,
	PaginatedSessions,
	RequestOptions,
	StreamEvent,
} from "./types";

class MemoryStorage implements ChatStorage {
	public saved: ChatSession[] = [];
	public deleted: string[] = [];

	async loadSessions(): Promise<PaginatedSessions> {
		return { items: [], hasMore: false };
	}

	async loadOne(): Promise<ChatSession | null> {
		return null;
	}

	async save(session: ChatSession): Promise<void> {
		this.saved.push(session);
	}

	async updateMetadata(_id: string, _meta: Partial<ChatSessionMeta>): Promise<void> {}

	async delete(id: string): Promise<void> {
		this.deleted.push(id);
	}
}

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

	await engine.sendMessage("hello");
	await beforeSubmitStartedPromise;
	await engine.stopGeneration();

	releaseBeforeSubmit();
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(pluginSawAbortedSignal, true);
	assert.equal(providerCalled, false);
	assert.equal(engine.store.get().generatingMessageId, null);
	assert.equal(engine.store.get().messages.length, 1);
	assert.equal(engine.store.get().messages[0].role, "user");
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
	})();

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
	engine.store.set({ isLoadingSession: false });

	await engine.sendMessage("hello");
	await streamStartedPromise;
	await engine.deleteSession("active-session");

	releaseStream();
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.deepEqual(calls, ["save:active-session", "delete:active-session"]);
	assert.equal(storage.saved.length, 1);
	assert.equal(storage.deleted.length, 1);
	assert.notEqual(engine.store.get().currentSessionId, "active-session");
});
