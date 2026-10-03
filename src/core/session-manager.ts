import { uuidv7 } from "../utils/uuid";
import type { ConversationModel } from "./conversation";
import { dropEphemeralMessages, extractPlainText } from "./msg-utils";
import type { Store } from "./store";
import {
	type ChatSession,
	type ChatSessionMeta,
	type ChatState,
	type ChatStorage,
	type ContentBlock,
	MAX_PINNED_SESSIONS,
	type Message,
} from "./types";

export type SessionState = Omit<
	ChatState,
	"currentSessionId" | "messages" | "generatingMessageId" | "hasMoreMessages"
> & { olderCursor: string | null };

interface SessionManagerConfig {
	store: Pick<Store<SessionState>, "get" | "set">;
	conversation: ConversationModel;
	storage: ChatStorage;
	isGenerationActive: () => boolean;
	stopActiveGeneration: () => Promise<void>;
}

const OLDER_MESSAGES_PAGE_SIZE = 100;

export interface ChatSessions {
	loadHistory(): Promise<void>;
	loadMore(): Promise<void>;
	/** Prepends an older page when the storage supports it and more history is available. */
	loadOlderMessages(): Promise<void>;
	create(): Promise<void>;
	switch(id: string): Promise<void>;
	delete(id: string): Promise<void>;
	updateTitle(sessionId: string, title: string): Promise<void>;
	updatePinned(sessionId: string, isPinned: boolean): Promise<void>;
}

export class SessionManager implements ChatSessions {
	private store: SessionManagerConfig["store"];
	private conversation: ConversationModel;
	private storage: ChatStorage;
	private isGenerationActive: () => boolean;
	private stopActiveGeneration: () => Promise<void>;
	private activeSessionMeta: ChatSessionMeta | null = null;
	private sessionWriteQueues = new Map<string, Promise<void>>();
	private deletedSessionIds = new Set<string>();
	private isFetchingSessions = false;
	private sessionPageCursor: ChatSessionMeta | null = null;
	private navigationRevision = 0;

	constructor(config: SessionManagerConfig) {
		this.store = config.store;
		this.conversation = config.conversation;
		this.storage = config.storage;
		this.isGenerationActive = config.isGenerationActive;
		this.stopActiveGeneration = config.stopActiveGeneration;
	}

	public isDeleted(sessionId: string): boolean {
		return this.deletedSessionIds.has(sessionId);
	}

	public async loadInitial(id: string): Promise<void> {
		await this.loadSession(id, "Chat not found. Started a new one.");
	}

	public async loadHistory(): Promise<void> {
		await this.fetchSessionsPage(false);
	}

	public async loadMore(): Promise<void> {
		await this.fetchSessionsPage(true);
	}

	public async loadOlderMessages(): Promise<void> {
		if (!this.storage.loadOlderMessages) return;
		const snapshot = this.conversation.state;
		if (this.state.isLoadingMessages || this.state.olderCursor === null) return;
		const sessionId = snapshot.id;
		const cursor = this.state.olderCursor;
		this.store.set({ isLoadingMessages: true });

		try {
			const page = await this.storage.loadOlderMessages(sessionId, cursor, OLDER_MESSAGES_PAGE_SIZE);
			// Drop the result if the user switched/reloaded the session meanwhile.
			if (this.conversation.state !== snapshot) return;
			if (page.hasMore && typeof page.nextOlderMessagesCursor !== "string")
				throw new Error("Older messages page is missing its next cursor");
			this.conversation.prepend(sessionId, page.messages);
			this.store.set({ olderCursor: page.hasMore ? (page.nextOlderMessagesCursor ?? null) : null });
		} catch (error) {
			console.error("Failed to load older messages", error);
		} finally {
			if (this.conversation.state === snapshot) this.store.set({ isLoadingMessages: false });
		}
	}

	public async create(): Promise<void> {
		const revision = ++this.navigationRevision;
		if (this.isGenerationActive()) {
			await this.stopActiveGeneration();
		}
		if (revision !== this.navigationRevision) return;
		this.startNewSession();
	}

	public async switch(id: string): Promise<void> {
		await this.loadSession(id, "Failed to load chat. Started a new one.");
	}

	public async delete(id: string): Promise<void> {
		if (this.deletedSessionIds.has(id)) return;
		const sessionMeta =
			this.state.sessions.find((session) => session.id === id) ??
			(this.activeSessionMeta?.id === id ? this.activeSessionMeta : null);
		const isCurrent = this.conversation.state.id === id;
		const revision = isCurrent ? ++this.navigationRevision : this.navigationRevision;
		this.deletedSessionIds.add(id);
		this.activeSessionMeta = this.activeSessionMeta?.id === id ? null : this.activeSessionMeta;
		this.store.set({
			sessions: this.state.sessions.filter((s) => s.id !== id),
		});

		try {
			if (isCurrent && this.isGenerationActive()) {
				await this.stopActiveGeneration();
			}

			if (isCurrent && revision === this.navigationRevision && this.conversation.state.id === id) {
				this.startNewSession();
			}

			await this.enqueueSessionWrite(id, async () => {
				await this.storage.delete(id);
			});
		} catch (error) {
			console.error(`Failed to delete session "${id}"`, error);
			this.deletedSessionIds.delete(id);
			this.store.set({
				sessions: sessionMeta ? this.withActiveSessionMeta([...this.state.sessions, sessionMeta]) : this.state.sessions,
				error: { message: "Failed to delete chat." },
			});
		}
	}

	public async persistSessionSnapshot(sessionId: string, messages: Message[]): Promise<boolean> {
		if (this.deletedSessionIds.has(sessionId)) return false;

		const messagesToSave = dropEphemeralMessages(messages);
		const olderCursor = this.conversation.state.id === sessionId ? this.state.olderCursor : null;

		try {
			return await this.enqueueSessionWrite(sessionId, async () => {
				if (this.deletedSessionIds.has(sessionId)) return false;

				// Resolve title/isPinned here, not at enqueue time: an earlier queued
				// write (e.g. auto-title's updateTitle) may change them before this
				// operation runs, and a stale snapshot would overwrite that update.
				const existingMeta = this.state.sessions.find((s) => s.id === sessionId);
				const title = existingMeta?.title ?? this.createFallbackTitle(messagesToSave);
				const isPinned =
					existingMeta?.isPinned ??
					(this.activeSessionMeta?.id === sessionId ? this.activeSessionMeta.isPinned : undefined);

				const sessionToSave: ChatSession = {
					id: sessionId,
					title,
					updatedAt: Date.now(),
					...(typeof isPinned === "boolean" ? { isPinned } : {}),
					messages: messagesToSave,
					...(olderCursor !== null ? { hasMoreMessages: true, nextOlderMessagesCursor: olderCursor } : {}),
				};

				await this.storage.save(sessionToSave);

				if (this.deletedSessionIds.has(sessionId)) return false;

				const sessionMeta = this.toSessionMeta(sessionToSave);
				if (this.conversation.state.id === sessionId) {
					this.activeSessionMeta = sessionMeta;
				}
				this.store.set({
					sessions: this.sortSessionMetas([sessionMeta, ...this.state.sessions.filter((s) => s.id !== sessionId)]),
				});

				return true;
			});
		} catch (error) {
			console.error(`Failed to persist session "${sessionId}"`, error);
			if (this.conversation.state.id === sessionId && !this.deletedSessionIds.has(sessionId) && !this.state.error)
				this.store.set({ error: { message: "Failed to save chat." } });
			return false;
		}
	}

	public async updateTitle(sessionId: string, title: string): Promise<void> {
		if (this.deletedSessionIds.has(sessionId)) return;
		const nextTitle = title.trim();
		if (!nextTitle) return;

		const existingTitle =
			this.state.sessions.find((s) => s.id === sessionId)?.title ??
			(this.activeSessionMeta?.id === sessionId ? this.activeSessionMeta.title : undefined);
		if (existingTitle === nextTitle) return;

		await this.enqueueSessionWrite(sessionId, async () => {
			if (this.deletedSessionIds.has(sessionId)) return;

			if (this.storage.updateMetadata) {
				await this.storage.updateMetadata(sessionId, { title: nextTitle });
			}

			if (this.deletedSessionIds.has(sessionId)) return;
			if (!this.state.sessions.find((s) => s.id === sessionId)) return;

			this.store.set({
				sessions: this.sortSessionMetas(
					this.state.sessions.map((s) => (s.id === sessionId ? { ...s, title: nextTitle } : s)),
				),
			});
			if (this.conversation.state.id === sessionId && this.activeSessionMeta?.id === sessionId) {
				this.activeSessionMeta = { ...this.activeSessionMeta, title: nextTitle };
			}
		});
	}

	public async updatePinned(sessionId: string, isPinned: boolean): Promise<void> {
		if (this.deletedSessionIds.has(sessionId)) return;

		const current =
			this.state.sessions.find((s) => s.id === sessionId) ??
			(this.activeSessionMeta?.id === sessionId ? this.activeSessionMeta : null);
		if (!current) return;
		if (Boolean(current.isPinned) === isPinned) return;
		if (isPinned && this.countPinnedSessions(sessionId) >= MAX_PINNED_SESSIONS) return;

		await this.enqueueSessionWrite(sessionId, async () => {
			if (this.deletedSessionIds.has(sessionId)) return;

			if (this.storage.updateMetadata) {
				await this.storage.updateMetadata(sessionId, { isPinned });
			}

			if (this.deletedSessionIds.has(sessionId)) return;
			if (!this.state.sessions.find((s) => s.id === sessionId)) return;

			this.store.set({
				sessions: this.sortSessionMetas(this.state.sessions.map((s) => (s.id === sessionId ? { ...s, isPinned } : s))),
			});
			if (this.conversation.state.id === sessionId && this.activeSessionMeta?.id === sessionId) {
				this.activeSessionMeta = { ...this.activeSessionMeta, isPinned };
			}
		});
	}

	public async close(): Promise<void> {
		this.navigationRevision++;
		await Promise.all(this.sessionWriteQueues.values());
		await this.storage.close?.();
	}

	private get state(): SessionState {
		return this.store.get();
	}

	private async fetchSessionsPage(append: boolean): Promise<void> {
		if (this.isFetchingSessions || (append && !this.state.hasMoreSessions)) return;

		this.isFetchingSessions = true;
		this.store.set({ isLoadingSessions: true });

		try {
			const cursor = append ? (this.sessionPageCursor ?? undefined) : undefined;

			const result = await this.storage.loadSessions(20, cursor);
			if (!append) this.sessionPageCursor = null;
			if (result.items.length > 0) {
				this.sessionPageCursor = result.items[result.items.length - 1];
			}

			const nextSessions = append ? [...this.state.sessions, ...result.items] : result.items;

			this.store.set({
				sessions: this.withActiveSessionMeta(nextSessions),
				hasMoreSessions: result.items.length > 0 ? result.hasMore : false,
				isLoadingSessions: false,
			});
		} catch (error) {
			console.error("Failed to load sessions", error);
			this.store.set(
				this.state.error || append
					? { isLoadingSessions: false }
					: { isLoadingSessions: false, error: { message: "Failed to load chat history." } },
			);
			// Let the pagination control stop automatic loading until the user retries.
			if (append) throw error;
		} finally {
			this.isFetchingSessions = false;
		}
	}

	private async loadSession(id: string, failureMessage: string): Promise<void> {
		// Record intent before stopping/saving, including a return to the current
		// session: it must cancel any older transition still waiting to start.
		const revision = ++this.navigationRevision;
		if (this.conversation.state.id === id && !this.state.isLoadingSession && !this.deletedSessionIds.has(id)) return;

		if (this.isGenerationActive()) {
			await this.stopActiveGeneration();
		}
		if (revision !== this.navigationRevision) return;

		this.activeSessionMeta = null;
		this.conversation.setConversation({ id, messages: [] });
		const snapshot = this.conversation.state;
		this.store.set({
			olderCursor: null,
			isLoadingSession: true,
			isLoadingMessages: false,
			error: null,
		});

		try {
			// A completed generation can still be saving when the user returns.
			// Read only after this session's queued writes, leaving other chats free.
			const pendingWrite = this.sessionWriteQueues.get(id);
			if (pendingWrite) await pendingWrite;
			if (revision !== this.navigationRevision || this.conversation.state !== snapshot) return;
			const session = await this.storage.loadOne(id);
			if (revision !== this.navigationRevision || this.conversation.state !== snapshot) return;
			if (this.deletedSessionIds.has(id)) throw new Error("Chat not found");

			if (!session) throw new Error("Chat not found");
			if (session.hasMoreMessages && typeof session.nextOlderMessagesCursor !== "string")
				throw new Error("Chat history is missing its next cursor");

			this.activeSessionMeta = this.toSessionMeta(session);
			this.conversation.setConversation({
				id,
				messages: session.messages,
			});
			this.store.set({
				olderCursor: session.hasMoreMessages ? (session.nextOlderMessagesCursor ?? null) : null,
				sessions: this.withActiveSessionMeta(this.state.sessions),
				isLoadingSession: false,
			});
		} catch (error) {
			if (revision !== this.navigationRevision || this.conversation.state !== snapshot) return;
			console.error(`Failed to load session "${id}"`, error);

			this.activeSessionMeta = null;
			this.conversation.setConversation({ id: uuidv7(), messages: [] });
			this.store.set({
				olderCursor: null,
				isLoadingSession: false,
				isLoadingMessages: false,
				error: { message: failureMessage },
			});
		}
	}

	private startNewSession(): void {
		this.activeSessionMeta = null;
		this.conversation.setConversation({ id: uuidv7(), messages: [] });
		this.store.set({
			olderCursor: null,
			isLoadingSession: false,
			isLoadingMessages: false,
			error: null,
		});
	}

	private toSessionMeta(session: ChatSession): ChatSessionMeta {
		return {
			id: session.id,
			title: session.title,
			updatedAt: session.updatedAt,
			...(typeof session.isPinned === "boolean" ? { isPinned: session.isPinned } : {}),
		};
	}

	private withActiveSessionMeta(sessions: ChatSessionMeta[]): ChatSessionMeta[] {
		const seen = new Set<string>();
		const deduped = sessions.filter((s) => {
			if (this.deletedSessionIds.has(s.id) || seen.has(s.id)) return false;
			seen.add(s.id);
			return true;
		});

		if (
			this.activeSessionMeta &&
			!this.deletedSessionIds.has(this.activeSessionMeta.id) &&
			!seen.has(this.activeSessionMeta.id)
		)
			deduped.push(this.activeSessionMeta);
		return this.sortSessionMetas(deduped);
	}

	private sortSessionMetas(sessions: ChatSessionMeta[]): ChatSessionMeta[] {
		return sessions.sort((a, b) => {
			const pinnedDelta = Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned));
			if (pinnedDelta !== 0) return pinnedDelta;
			return b.updatedAt - a.updatedAt || b.id.localeCompare(a.id);
		});
	}

	private countPinnedSessions(exceptSessionId?: string): number {
		return this.state.sessions.filter((session) => session.id !== exceptSessionId && session.isPinned).length;
	}

	private createFallbackTitle(messages: Message[]): string {
		const firstMsg = messages[0];
		if (!firstMsg) return "Empty Chat";

		const text = extractPlainText(firstMsg);
		if (text.trim().length > 0) {
			return text.length > 30 ? `${text.slice(0, 30)}...` : text;
		}

		const fileBlock = firstMsg.blocks.find((b): b is Extract<ContentBlock, { type: "file" }> => b.type === "file");
		if (fileBlock) return `File: ${fileBlock.name || "Upload"}`;

		return "New Chat";
	}

	private enqueueSessionWrite<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
		const previousWrite = this.sessionWriteQueues.get(sessionId) ?? Promise.resolve();
		const write = previousWrite.then(operation);
		const settledWrite = write.then(
			() => undefined,
			() => undefined,
		);

		this.sessionWriteQueues.set(sessionId, settledWrite);
		void settledWrite.finally(() => {
			if (this.sessionWriteQueues.get(sessionId) === settledWrite) {
				this.sessionWriteQueues.delete(sessionId);
			}
		});

		return write;
	}
}
