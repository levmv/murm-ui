import { uuidv7 } from "../utils/uuid";
import { dropEmptyAssistantMessages, extractPlainText } from "./msg-utils";
import type { Store } from "./store";
import type { ChatSession, ChatSessionMeta, ChatState, ChatStorage, ContentBlock, Message } from "./types";

interface SessionManagerConfig {
	store: Store<ChatState>;
	storage: ChatStorage;
	isGenerationActive: () => boolean;
	stopActiveGeneration: () => Promise<void>;
}

export interface ChatSessions {
	loadHistory(): Promise<void>;
	loadMore(): Promise<void>;
	create(): Promise<void>;
	switch(id: string): Promise<void>;
	delete(id: string): Promise<void>;
	updateTitle(sessionId: string, title: string): Promise<void>;
}

export class SessionManager implements ChatSessions {
	private store: Store<ChatState>;
	private storage: ChatStorage;
	private isGenerationActive: () => boolean;
	private stopActiveGeneration: () => Promise<void>;
	private activeSessionMeta: ChatSessionMeta | null = null;
	private sessionWriteQueues = new Map<string, Promise<void>>();
	private deletedSessionIds = new Set<string>();
	private isFetchingSessions = false;
	private switchSeq = 0;

	constructor(config: SessionManagerConfig) {
		this.store = config.store;
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

	// Call this when the user scrolls to the bottom of the sidebar
	public async loadMore(): Promise<void> {
		await this.fetchSessionsPage(true);
	}

	public async create(): Promise<void> {
		if (this.isGenerationActive()) {
			await this.stopActiveGeneration();
		}
		this.startNewSession();
	}

	public async switch(id: string): Promise<void> {
		await this.loadSession(id, "Failed to load chat. Started a new one.");
	}

	public async delete(id: string): Promise<void> {
		const isCurrent = this.state.currentSessionId === id;
		this.deletedSessionIds.add(id);
		this.activeSessionMeta = this.activeSessionMeta?.id === id ? null : this.activeSessionMeta;
		this.store.set({
			sessions: this.state.sessions.filter((s) => s.id !== id),
		});

		try {
			if (isCurrent && this.isGenerationActive()) {
				await this.stopActiveGeneration();
			}

			if (isCurrent && this.state.currentSessionId === id) {
				this.startNewSession();
			}

			await this.enqueueSessionWrite(id, async () => {
				await this.storage.delete(id);
			});
		} catch (error) {
			console.error(`Failed to delete session "${id}"`, error);
		}
	}

	public async persistSessionSnapshot(sessionId: string, messages: Message[]): Promise<boolean> {
		if (this.deletedSessionIds.has(sessionId)) return false;

		const existingMeta = this.state.sessions.find((s) => s.id === sessionId);
		const title = existingMeta?.title ?? this.createFallbackTitle(messages);
		const updatedAt = Date.now();

		const sessionToSave: ChatSession = {
			id: sessionId,
			title,
			updatedAt,
			messages: dropEmptyAssistantMessages(messages),
		};

		try {
			return await this.enqueueSessionWrite(sessionId, async () => {
				if (this.deletedSessionIds.has(sessionId)) return false;
				await this.storage.save(sessionToSave);

				if (this.deletedSessionIds.has(sessionId)) return false;

				const sessionMeta = { id: sessionId, title, updatedAt };
				if (this.state.currentSessionId === sessionId) {
					this.activeSessionMeta = sessionMeta;
				}
				this.store.set({
					sessions: [sessionMeta, ...this.state.sessions.filter((s) => s.id !== sessionId)],
				});

				return true;
			});
		} catch (error) {
			console.error(`Failed to persist session "${sessionId}"`, error);
			return false;
		}
	}

	public async updateTitle(sessionId: string, title: string): Promise<void> {
		if (this.deletedSessionIds.has(sessionId)) return;

		await this.enqueueSessionWrite(sessionId, async () => {
			if (this.deletedSessionIds.has(sessionId)) return;

			if (this.storage.updateMetadata) {
				await this.storage.updateMetadata(sessionId, { title });
			}

			if (this.deletedSessionIds.has(sessionId)) return;
			if (!this.state.sessions.find((s) => s.id === sessionId)) return;

			this.store.set({
				sessions: this.state.sessions.map((s) => (s.id === sessionId ? { ...s, title } : s)),
			});
			if (this.state.currentSessionId === sessionId && this.activeSessionMeta?.id === sessionId) {
				this.activeSessionMeta = { ...this.activeSessionMeta, title };
			}
		});
	}

	public async close(): Promise<void> {
		if (this.storage.close) {
			await this.storage.close();
		}
	}

	private get state(): ChatState {
		return this.store.get();
	}

	private async fetchSessionsPage(append: boolean): Promise<void> {
		if (this.isFetchingSessions || (append && !this.state.hasMoreSessions)) return;

		this.isFetchingSessions = true;
		this.store.set({ isLoadingSessions: true });

		try {
			const sessions = this.state.sessions;
			const cursor =
				append && sessions.length > 0
					? { updatedAt: sessions[sessions.length - 1].updatedAt, id: sessions[sessions.length - 1].id }
					: undefined;

			const result = await this.storage.loadSessions(20, cursor);
			const resultItems = this.withoutDeletedSessions(result.items);
			const nextSessions = append ? [...this.state.sessions, ...resultItems] : resultItems;

			this.store.set({
				sessions: this.withActiveSessionMeta(nextSessions),
				hasMoreSessions: result.items.length > 0 ? result.hasMore : false,
				isLoadingSessions: false,
			});
		} catch (error) {
			console.error("Failed to load sessions", error);
			this.store.set(
				this.state.error
					? { isLoadingSessions: false }
					: { isLoadingSessions: false, error: { message: "Failed to load chat history." } },
			);
		} finally {
			this.isFetchingSessions = false;
		}
	}

	private async loadSession(id: string, failureMessage: string): Promise<void> {
		if (this.state.currentSessionId === id && !this.state.isLoadingSession) return;

		if (this.isGenerationActive()) {
			await this.stopActiveGeneration();
		}

		const seq = ++this.switchSeq;
		this.activeSessionMeta = null;

		this.store.set({
			currentSessionId: id,
			messages: [],
			isLoadingSession: true,
			error: null,
		});

		try {
			const session = await this.storage.loadOne(id);
			if (seq !== this.switchSeq) return; // stale

			// User may have navigated again while this one was loading
			if (this.state.currentSessionId !== id) return;
			if (this.deletedSessionIds.has(id)) throw new Error("Chat not found");

			if (!session) throw new Error("Chat not found");

			this.activeSessionMeta = this.toSessionMeta(session);
			this.store.set({
				sessions: this.withActiveSessionMeta(this.state.sessions),
				messages: session.messages,
				isLoadingSession: false,
			});
		} catch (error) {
			console.error(`Failed to load session "${id}"`, error);
			if (seq !== this.switchSeq) return;
			if (this.state.currentSessionId !== id) return;

			this.activeSessionMeta = null;
			this.store.set({
				messages: [],
				currentSessionId: uuidv7(),
				isLoadingSession: false,
				error: { message: failureMessage },
			});
		}
	}

	private startNewSession(): void {
		this.activeSessionMeta = null;
		this.store.set({
			currentSessionId: uuidv7(),
			messages: [],
			isLoadingSession: false,
			error: null,
		});
	}

	private toSessionMeta(session: ChatSession): ChatSessionMeta {
		return { id: session.id, title: session.title, updatedAt: session.updatedAt };
	}

	private withActiveSessionMeta(sessions: ChatSessionMeta[]): ChatSessionMeta[] {
		sessions = this.withoutDeletedSessions(sessions);
		const seen = new Set<string>();
		const deduped = sessions.filter((s) => {
			if (seen.has(s.id)) return false;
			seen.add(s.id);
			return true;
		});

		if (!this.activeSessionMeta || this.deletedSessionIds.has(this.activeSessionMeta.id)) return deduped;
		if (deduped.some((session) => session.id === this.activeSessionMeta?.id)) return deduped;
		return [this.activeSessionMeta, ...deduped];
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
		const previous = this.sessionWriteQueues.get(sessionId) ?? Promise.resolve();
		const queued = previous.catch(() => undefined).then(operation);
		const tracked = queued.then(
			() => undefined,
			() => undefined,
		);

		this.sessionWriteQueues.set(sessionId, tracked);
		void tracked.finally(() => {
			if (this.sessionWriteQueues.get(sessionId) === tracked) {
				this.sessionWriteQueues.delete(sessionId);
			}
		});

		return queued;
	}

	private withoutDeletedSessions(sessions: ChatSessionMeta[]): ChatSessionMeta[] {
		if (this.deletedSessionIds.size === 0) return sessions;
		return sessions.filter((session) => !this.deletedSessionIds.has(session.id));
	}
}
