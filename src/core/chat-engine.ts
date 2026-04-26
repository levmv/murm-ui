import { uuidv7 } from "../utils/uuid";
import { extractPlainText } from "./msg-utils";
import { Store } from "./store";
import type {
	ChatPlugin,
	ChatProvider,
	ChatRequestParams,
	ChatSession,
	ChatState,
	ChatStorage,
	ContentBlock,
	Message,
	ReadonlyChatRequestParams,
	RequestOptions,
	StreamEvent,
} from "./types";

export interface ChatEngineConfig {
	provider: ChatProvider;
	storage: ChatStorage;
	initialSessionId?: string | null;
}

export class ChatEngine {
	private store: Store<ChatState>;

	private provider: ChatProvider;
	private storage: ChatStorage;
	private plugins: ChatPlugin[] = [];
	private requestDefaults: Partial<RequestOptions> = {};
	private activeGeneration: { id: string; controller: AbortController } | null = null;

	private isFetchingSessions = false;

	private switchSeq = 0;

	constructor(config: ChatEngineConfig) {
		this.provider = config.provider;
		this.storage = config.storage;

		const startingId = config.initialSessionId || uuidv7();

		this.store = new Store<ChatState>({
			sessions: [],
			hasMoreSessions: false,
			currentSessionId: startingId,
			messages: [],
			generatingMessageId: null,
			isLoadingSession: true,
			error: null,
		});

		this.init(startingId, !!config.initialSessionId);
	}

	public registerPlugins(plugins: ChatPlugin[]) {
		this.plugins = plugins;
	}

	public get state(): ChatState {
		return this.store.get();
	}

	public subscribe<U>(selector: (state: ChatState) => U, listener: (selectedState: U) => void): () => void {
		return this.store.subscribe(selector, listener);
	}

	public subscribeHot(listener: (state: ChatState) => void): () => void {
		return this.store.subscribeHot(listener);
	}

	private get isBusy() {
		return this.activeGeneration !== null;
	}

	public async setProvider(newProvider: ChatProvider) {
		if (this.isBusy) await this.stopGeneration();
		this.provider = newProvider;
	}

	public clearError() {
		this.store.set({ error: null });
	}

	// Call this when the user scrolls to the bottom of the sidebar
	public async loadMoreSessions() {
		if (this.isFetchingSessions || !this.state.hasMoreSessions) return;

		this.isFetchingSessions = true;

		try {
			const sessions = this.state.sessions;
			const cursor =
				sessions.length > 0
					? { updatedAt: sessions[sessions.length - 1].updatedAt, id: sessions[sessions.length - 1].id }
					: undefined;

			const result = await this.storage.loadSessions(20, cursor);

			if (result.items.length > 0) {
				this.store.set({
					sessions: [...this.state.sessions, ...result.items],
					hasMoreSessions: result.hasMore,
				});
			} else {
				this.store.set({ hasMoreSessions: false });
			}
		} catch (error) {
			console.error("Failed to load more sessions", error);
		} finally {
			this.isFetchingSessions = false;
		}
	}

	public async createNewSession() {
		if (this.isBusy) await this.stopGeneration();

		this.store.set({
			currentSessionId: uuidv7(),
			messages: [],
			error: null,
		});
	}

	public async switchSession(id: string) {
		if (this.state.currentSessionId === id) return;
		if (this.isBusy) await this.stopGeneration();

		const seq = ++this.switchSeq;

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

			if (!session) throw new Error("Chat not found");

			this.store.set({
				messages: session ? session.messages : [],
				isLoadingSession: false,
			});
		} catch (error) {
			console.error(`Failed to load session "${id}"`, error);
			if (seq !== this.switchSeq) return;
			if (this.state.currentSessionId !== id) return;

			this.store.set({
				messages: [],
				currentSessionId: uuidv7(),
				isLoadingSession: false,
				error: { message: "Failed to load chat. Started a new one." },
			});
		}
	}

	public async deleteSession(id: string) {
		try {
			const isCurrent = this.state.currentSessionId === id;
			if (isCurrent && this.isBusy) {
				await this.stopGeneration();
			}

			await this.storage.delete(id);

			this.store.set({
				sessions: this.state.sessions.filter((s) => s.id !== id),
			});

			if (isCurrent) {
				await this.createNewSession();
			}
		} catch (error) {
			console.error(`Failed to delete session "${id}"`, error);
		}
	}

	public async sendMessage(content: string) {
		if (this.isBusy) return;

		const currentMessages = this.cleanDeadMessages(this.state.messages);

		const userMsg: Message = {
			id: uuidv7(),
			role: "user",
			blocks: content ? [{ id: uuidv7(), type: "text", text: content }] : [],
		};

		for (const plugin of this.plugins) {
			if (plugin.onUserSubmit) {
				plugin.onUserSubmit(userMsg);
			}
		}

		this.startGeneration([...currentMessages, userMsg]);
	}

	public async editAndResubmit(messageId: string, newContent: string) {
		if (this.isBusy) return;

		const currentMessages = this.cleanDeadMessages(this.state.messages);
		const targetIndex = currentMessages.findIndex((m) => m.id === messageId);

		if (targetIndex === -1) return;

		// Truncate history to remove everything AFTER the edited message
		// and update the edited message itself
		const updatedMessages = currentMessages.slice(0, targetIndex + 1);

		// Preserve non-text blocks (like images/files) and append the edited text
		const preservedBlocks = updatedMessages[targetIndex].blocks.filter((b) => b.type !== "text");
		const newTextBlock = newContent ? [{ id: uuidv7(), type: "text" as const, text: newContent }] : [];

		updatedMessages[targetIndex] = {
			...updatedMessages[targetIndex],
			blocks: [...preservedBlocks, ...newTextBlock],
		};

		this.startGeneration(updatedMessages);
	}

	/**
	 * Completely replaces the current session's message history and saves it to storage.
	 * Useful for clearing history, compacting context, or modifying past messages.
	 */
	public async setMessages(messages: Message[]) {
		if (this.isBusy) {
			console.warn("Cannot modify history while the AI is generating a response.");
			return;
		}

		this.store.set({ messages });
		await this.persistCurrentSession();
	}

	/**
	 * Sets global default options (e.g., systemPrompt, temperature) for all outgoing requests.
	 */
	public setRequestDefaults(defaults: Partial<RequestOptions>) {
		this.requestDefaults = { ...this.requestDefaults, ...defaults };
	}

	public async stopGeneration() {
		if (!this.isBusy) return;

		const generation = this.activeGeneration;
		if (!generation) return;

		generation.controller.abort();
		this.applyStreamEvent(generation.id, { type: "finish", reason: "aborted" });
		await this.finalizeGeneration(generation.id, true);
	}

	public async destroy() {
		await this.stopGeneration();
		if (this.storage.close) {
			this.storage.close();
		}
		this.store.clearAllListeners();
	}

	private async init(targetId: string, isFromUrl: boolean) {
		try {
			await this.loadInitialState(targetId, isFromUrl);
		} catch (error) {
			console.error("Storage Error during init:", error);
			this.store.set({
				currentSessionId: uuidv7(),
				isLoadingSession: false,
				error: { message: "Failed to load history. Chatting in memory mode." },
			});
		}
	}

	private async loadInitialState(targetId: string, isFromUrl: boolean) {
		const result = await this.storage.loadSessions(20);
		const sessions = result.items;

		let activeSession: ChatSession | null = null;

		if (isFromUrl) {
			activeSession = await this.storage.loadOne(targetId);
			if (!activeSession) {
				if (this.state.currentSessionId !== targetId) return;

				this.store.set({
					sessions,
					hasMoreSessions: result.hasMore,
					currentSessionId: uuidv7(),
					messages: [],
					isLoadingSession: false,
					error: { message: "Chat not found. Started a new one." },
				});
				return;
			}

			if (activeSession && !sessions.find((s) => s.id === targetId)) {
				// Inject metadata into sidebar if it wasn't in the first 20
				sessions.unshift({
					id: activeSession.id,
					title: activeSession.title,
					updatedAt: activeSession.updatedAt,
				});
			}
		} else if (sessions.length > 0) {
			// Default behavior: just load the most recent chat
			activeSession = await this.storage.loadOne(sessions[0].id);
		}

		if (activeSession) {
			if (this.state.currentSessionId !== targetId) return;
			this.store.set({
				sessions,
				hasMoreSessions: result.hasMore,
				currentSessionId: activeSession.id,
				messages: activeSession.messages,
				isLoadingSession: false,
			});
		} else {
			this.store.set({
				sessions,
				hasMoreSessions: result.hasMore,
				isLoadingSession: false,
			});
		}
	}

	private async startGeneration(contextMessages: Message[]) {
		const pendingId = uuidv7();
		const controller = new AbortController();
		const signal = controller.signal;
		this.activeGeneration = { id: pendingId, controller };

		// Instantly create an empty assistant message so the UI shows a loading state
		const assistantMsg: Message = {
			id: pendingId,
			role: "assistant",
			blocks: [],
		};

		const updatedMessages = [...contextMessages, assistantMsg];

		this.store.set({
			messages: updatedMessages,
			generatingMessageId: pendingId,
			error: null,
		});

		// Strip out dead UI messages and ephemeral local messages
		const validContext = contextMessages.filter((msg) => {
			if (msg.meta?.ephemeral) return false;
			if (msg.role === "assistant" && msg.blocks.length === 0) return false;
			return true;
		});

		let wasAborted = false;
		try {
			const payloadParams = await this.prepareRequestParams(validContext, signal);
			if (signal.aborted) {
				wasAborted = true;
				return;
			}

			if (payloadParams.options.systemPrompt) {
				payloadParams.messages = [
					{
						id: uuidv7(),
						role: "system",
						blocks: [{ id: uuidv7(), type: "text", text: payloadParams.options.systemPrompt }],
					},
					...payloadParams.messages,
				];
			}

			if (signal.aborted) {
				wasAborted = true;
				return;
			}

			await this.provider.streamChat(payloadParams.messages, payloadParams.options, signal, (event) => {
				if (signal.aborted) return;
				if (event.type === "finish" && event.reason === "aborted") {
					wasAborted = true;
				}
				this.applyStreamEvent(pendingId, event);
			});
		} catch (err: unknown) {
			if (signal.aborted) {
				wasAborted = true;
				return;
			}

			const errorMessage =
				err instanceof Error
					? err.message
					: typeof err === "object" && err !== null
						? JSON.stringify(err)
						: String(err);

			this.store.set({ error: { message: errorMessage, id: pendingId } });
		} finally {
			await this.finalizeGeneration(pendingId, wasAborted || signal.aborted);
		}
	}

	/**
	 * High-performance state reducer. Bypasses cloning by mutating the active blocks.
	 * @param pendingId The ID we generated locally to track the active response.
	 */
	private applyStreamEvent(pendingId: string, event: StreamEvent) {
		this.store.mutateHot((state) => {
			const msg = state.messages.find((m) => m.id === pendingId);
			if (!msg) return; // Only happens if user rapidly deleted the chat during stream

			switch (event.type) {
				case "message_start":
					// We already pushed a placeholder. We can optionally merge metadata.
					if (event.message.meta) {
						msg.meta = { ...msg.meta, ...event.message.meta };
					}
					break;

				case "text_delta": {
					let tb = msg.blocks.find((b) => b.id === event.blockId) as Extract<ContentBlock, { type: "text" }>;
					if (!tb) {
						tb = { id: event.blockId, type: "text", text: "" };
						msg.blocks.push(tb);
					}
					tb.text += event.delta;
					break;
				}

				case "reasoning_delta": {
					let rb = msg.blocks.find((b) => b.id === event.blockId) as Extract<ContentBlock, { type: "reasoning" }>;
					if (!rb) {
						rb = { id: event.blockId, type: "reasoning", text: "", encrypted: event.encrypted };
						msg.blocks.push(rb);
					}
					rb.text += event.delta;
					break;
				}

				case "tool_call_start":
					msg.blocks.push(event.block);
					break;

				case "tool_call_delta": {
					const tcb = msg.blocks.find((b) => b.id === event.blockId) as Extract<ContentBlock, { type: "tool_call" }>;
					if (tcb) {
						if (event.argsDelta) tcb.argsText += event.argsDelta;
						if (event.status) tcb.status = event.status;
					}
					break;
				}

				case "tool_result":
				case "artifact":
					msg.blocks.push(event.block);
					break;
				case "finish": {
					const finalStatus = event.reason === "error" || event.reason === "aborted" ? "error" : "complete";
					for (const b of msg.blocks) {
						if (b.type === "tool_call" && b.status === "streaming") {
							b.status = finalStatus;
						}
					}
					break;
				}
				// Usage, finish, error handled mostly outside mutation or discarded
				case "error":
					state.error = { message: event.message, id: pendingId };
					break;
			}
		});
	}

	private async prepareRequestParams(messages: Message[], signal: AbortSignal): Promise<ChatRequestParams> {
		const payloadParams: ChatRequestParams = {
			messages: [...messages],
			options: { ...this.requestDefaults },
			signal,
		};

		for (const plugin of this.plugins) {
			if (signal.aborted) return payloadParams;

			if (plugin.beforeSubmit) {
				const params = {
					messages: [...payloadParams.messages],
					options: { ...payloadParams.options },
					signal,
				} as ReadonlyChatRequestParams;
				const patch = await plugin.beforeSubmit(params);
				if (signal.aborted) return payloadParams;

				if (patch) {
					if (patch.messages) payloadParams.messages = patch.messages;
					if (patch.options) payloadParams.options = { ...payloadParams.options, ...patch.options };
				}
			}
		}

		return payloadParams;
	}

	private async finalizeGeneration(pendingId: string, wasAborted: boolean = false) {
		if (this.activeGeneration?.id !== pendingId) return;
		this.activeGeneration = null;

		if (wasAborted) {
			this.removeEmptyAbortedMessage(pendingId);
		}

		if (this.state.generatingMessageId === pendingId) {
			this.store.set({ generatingMessageId: null });
		}

		try {
			await this.persistCurrentSession();

			const currentMsgs = this.state.messages;
			const sessionId = this.state.currentSessionId;

			const hasError = this.state.error !== null;

			// Auto-title trigger
			if (!hasError && !wasAborted && this.provider.generateTitle) {
				const assistantRepliesCount = currentMsgs.filter((m) => m.role === "assistant" && m.blocks.length > 0).length;

				if (assistantRepliesCount === 1) {
					void this.triggerAutoTitle(sessionId, currentMsgs);
				}
			}
		} catch (error) {
			console.error("Failed to finalize stream", error);
		}
	}

	private removeEmptyAbortedMessage(pendingId: string): void {
		const pendingMessage = this.state.messages.find((m) => m.id === pendingId);
		if (!pendingMessage || pendingMessage.blocks.length > 0) return;

		this.store.set({
			messages: this.state.messages.filter((m) => m.id !== pendingId),
		});
	}

	private async persistCurrentSession(): Promise<boolean> {
		const { currentSessionId, messages, sessions } = this.store.get();
		if (messages.length === 0) return true;

		const existingMeta = sessions.find((s) => s.id === currentSessionId);
		let title = existingMeta?.title;

		if (!title) {
			const firstMsg = messages[0];
			const text = extractPlainText(firstMsg);
			if (text.trim().length > 0) {
				title = text.length > 30 ? text.slice(0, 30) + "..." : text;
			} else if (firstMsg.blocks.some((b) => b.type === "file")) {
				const fileBlock = firstMsg.blocks.find((b) => b.type === "file") as Extract<ContentBlock, { type: "file" }>;
				title = `File: ${fileBlock.name || "Upload"}`;
			} else {
				title = "New Chat";
			}
		}

		const updatedAt = Date.now();

		const sessionToSave: ChatSession = {
			id: currentSessionId,
			title,
			updatedAt,
			messages,
		};

		try {
			await this.storage.save(sessionToSave);

			this.store.set({
				sessions: [
					{ id: currentSessionId, title, updatedAt },
					...this.state.sessions.filter((s) => s.id !== currentSessionId),
				],
			});

			return true;
		} catch (error) {
			console.error(`Failed to persist session "${currentSessionId}"`, error);
			return false;
		}
	}

	private async triggerAutoTitle(sessionId: string, messages: Message[]) {
		try {
			const controller = new AbortController();
			const payloadParams = await this.prepareRequestParams(messages, controller.signal);

			const smartTitle = await this.provider.generateTitle!(
				payloadParams.messages,
				payloadParams.options,
				controller.signal,
			);
			if (!smartTitle) return;

			// user may have deleted this session while the title was generating in the background.
			if (!this.state.sessions.find((s) => s.id === sessionId)) return;

			if (this.storage.updateMetadata) {
				await this.storage.updateMetadata(sessionId, { title: smartTitle });
			}

			this.store.set({
				sessions: this.state.sessions.map((s) => (s.id === sessionId ? { ...s, title: smartTitle } : s)),
			});
		} catch (e) {
			console.error("Failed to auto-generate title", e);
		}
	}

	private cleanDeadMessages(messages: Message[]): Message[] {
		// Remove any assistant message that has 0 blocks (it failed before generating anything)
		return messages.filter((m) => !(m.role === "assistant" && m.blocks.length === 0));
	}
}
