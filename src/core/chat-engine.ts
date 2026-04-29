import { uuidv7 } from "../utils/uuid";
import { cloneMessages, dropEphemeralMessages } from "./msg-utils";
import { type ChatSessions, SessionManager } from "./session-manager";
import { Store } from "./store";
import { applyStreamEventToState, type StreamReducerEvent } from "./stream-reducer";
import type {
	ChatPlugin,
	ChatProvider,
	ChatRequestParams,
	ChatState,
	ChatStorage,
	Message,
	ReadonlyChatRequestParams,
	RequestOptions,
} from "./types";

export interface ChatEngineConfig {
	provider: ChatProvider;
	storage: ChatStorage;
	initialSessionId?: string | null;
	titleOptions?: Partial<RequestOptions>;
}

interface ActiveGeneration {
	id: string;
	sessionId: string;
	controller: AbortController;
	provider: ChatProvider;
	requestDefaults: Partial<RequestOptions>;
}

export class ChatEngine {
	private store: Store<ChatState>;
	private readonly sessionManager: SessionManager;
	public readonly sessions: ChatSessions;

	private provider: ChatProvider;
	private plugins: ChatPlugin[] = [];
	private requestDefaults: Partial<RequestOptions> = {};
	private titleOptions: Partial<RequestOptions> = {};
	private activeGeneration: ActiveGeneration | null = null;

	constructor(config: ChatEngineConfig) {
		this.provider = config.provider;
		this.titleOptions = this.withoutUndefinedOptions(config.titleOptions ?? {});

		const startingId = config.initialSessionId || uuidv7();

		this.store = new Store<ChatState>({
			sessions: [],
			hasMoreSessions: false,
			currentSessionId: startingId,
			messages: [],
			generatingMessageId: null,
			isLoadingSession: !!config.initialSessionId,
			isLoadingSessions: false,
			error: null,
		});
		this.sessionManager = new SessionManager({
			store: this.store,
			storage: config.storage,
			isGenerationActive: () => this.isBusy,
			stopActiveGeneration: () => this.stopGeneration(),
		});
		this.sessions = this.sessionManager;

		if (config.initialSessionId) {
			void this.sessionManager.loadInitial(startingId);
		}
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

	public onChange<U>(selector: (state: ChatState) => U, listener: (selectedState: U) => void): () => void {
		return this.store.onChange(selector, listener);
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

	public sendMessage(content: string): boolean {
		if (this.isBusy || this.state.isLoadingSession) return false;

		const currentMessages = dropEphemeralMessages(this.state.messages);

		const userMsg: Message = {
			id: uuidv7(),
			role: "user",
			blocks: content ? [{ id: uuidv7(), type: "text", text: content }] : [],
		};

		for (const plugin of this.plugins) {
			try {
				plugin.onUserSubmit?.(userMsg);
			} catch (error) {
				console.error(`Plugin "${plugin.name}" failed during onUserSubmit`, error);
			}
		}

		if (userMsg.blocks.length === 0) return false;

		void this.startGeneration([...currentMessages, userMsg]);
		return true;
	}

	public editAndResubmit(messageId: string, newContent: string): boolean {
		if (this.isBusy) return false;

		const currentMessages = dropEphemeralMessages(this.state.messages);
		const targetIndex = currentMessages.findIndex((m) => m.id === messageId);

		if (targetIndex === -1) return false;
		if (currentMessages[targetIndex].role !== "user") return false;

		// Truncate history to remove everything AFTER the edited message
		// and update the edited message itself
		const updatedMessages = currentMessages.slice(0, targetIndex + 1);

		// Preserve non-text blocks (like images/files) and append the edited text
		const preservedBlocks = updatedMessages[targetIndex].blocks.filter((b) => b.type !== "text");
		const newTextBlock = newContent ? [{ id: uuidv7(), type: "text" as const, text: newContent }] : [];
		const finalBlocks = [...preservedBlocks, ...newTextBlock];

		if (finalBlocks.length === 0) return false;

		updatedMessages[targetIndex] = {
			...updatedMessages[targetIndex],
			blocks: finalBlocks,
		};

		void this.startGeneration(updatedMessages);
		return true;
	}

	/**
	 * Completely replaces the current session's message history and attempts to save it to storage.
	 * Useful for clearing history, compacting context, or modifying past messages.
	 */
	public async setMessages(messages: Message[]): Promise<boolean> {
		if (this.isBusy) {
			console.warn("Cannot modify history while the AI is generating a response.");
			return false;
		}

		this.store.set({ messages });
		return await this.persistCurrentSession();
	}

	/**
	 * Sets global default options (e.g., systemPrompt, temperature) for all outgoing requests.
	 */
	public setRequestDefaults(defaults: Partial<RequestOptions>) {
		this.requestDefaults = { ...this.requestDefaults, ...defaults };
	}

	public setTitleOptions(options: Partial<RequestOptions>) {
		this.titleOptions = this.mergeDefinedOptions(this.titleOptions, options);
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
		await this.sessionManager.close();
		this.store.clearAllListeners();
	}

	private async startGeneration(contextMessages: Message[]) {
		const pendingId = uuidv7();
		const sessionId = this.state.currentSessionId;
		const provider = this.provider;
		const controller = new AbortController();
		const signal = controller.signal;
		this.activeGeneration = {
			id: pendingId,
			sessionId,
			controller,
			provider,
			requestDefaults: { ...this.requestDefaults },
		};

		// Instantly create an empty assistant message so the UI shows a loading state
		const assistantMsg: Message = {
			id: pendingId,
			role: "assistant",
			blocks: [],
			meta: { ephemeral: true },
		};

		const updatedMessages = [...contextMessages, assistantMsg];

		this.store.set({
			messages: updatedMessages,
			generatingMessageId: pendingId,
			error: null,
		});

		let wasAborted = false;
		try {
			const payloadParams = await this.prepareRequestParams(contextMessages, signal);
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

			await provider.streamChat(payloadParams.messages, payloadParams.options, signal, (event) => {
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

			this.applyStreamEvent(pendingId, { type: "error", message: errorMessage });
		} finally {
			await this.finalizeGeneration(pendingId, wasAborted || signal.aborted);
		}
	}

	/**
	 * Applies reducer events without cloning active stream blocks.
	 * @param pendingId The ID we generated locally to track the active response.
	 */
	private applyStreamEvent(pendingId: string, event: StreamReducerEvent) {
		this.store.mutateHot((state) => {
			applyStreamEventToState(state, pendingId, event);
		});
	}

	private async prepareRequestParams(
		messages: Message[],
		signal: AbortSignal,
		requestDefaults: Partial<RequestOptions> = this.requestDefaults,
	): Promise<ChatRequestParams> {
		const payloadParams: ChatRequestParams = {
			messages: [...messages],
			options: { ...requestDefaults },
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

		payloadParams.messages = dropEphemeralMessages(payloadParams.messages);

		return payloadParams;
	}

	private async finalizeGeneration(pendingId: string, wasAborted: boolean = false) {
		const generation = this.activeGeneration;
		if (generation?.id !== pendingId) return;
		this.activeGeneration = null;

		if (wasAborted) {
			this.removeAbortedEphemeralMessage(pendingId);
		}

		if (this.state.generatingMessageId === pendingId) {
			this.store.set({ generatingMessageId: null });
		}

		try {
			const finalMessages = cloneMessages(this.state.messages);
			const persistentMessages = dropEphemeralMessages(finalMessages);
			const hasError = this.state.error !== null;
			const saved = await this.sessionManager.persistSessionSnapshot(generation.sessionId, finalMessages);

			if (!saved) return;

			// Auto-title trigger
			if (!hasError && !wasAborted && generation.provider.generateTitle) {
				const assistantRepliesCount = persistentMessages.filter(
					(m) => m.role === "assistant" && m.blocks.length > 0,
				).length;

				if (assistantRepliesCount === 1) {
					void this.triggerAutoTitle(
						generation.sessionId,
						persistentMessages,
						generation.provider,
						generation.requestDefaults,
					);
				}
			}
		} catch (error) {
			console.error("Failed to finalize stream", error);
		}
	}

	private removeAbortedEphemeralMessage(pendingId: string): void {
		const pendingMessage = this.state.messages.find((m) => m.id === pendingId);
		if (!pendingMessage?.meta?.ephemeral) return;

		this.store.set({
			messages: this.state.messages.filter((m) => m.id !== pendingId),
		});
	}

	private async persistCurrentSession(): Promise<boolean> {
		const { currentSessionId, messages } = this.store.get();
		return await this.sessionManager.persistSessionSnapshot(currentSessionId, cloneMessages(messages));
	}

	private async triggerAutoTitle(
		sessionId: string,
		messages: Message[],
		provider: ChatProvider,
		requestDefaults: Partial<RequestOptions>,
	) {
		if (this.sessionManager.isDeleted(sessionId)) return;

		try {
			const controller = new AbortController();
			const payloadMessages = dropEphemeralMessages(messages);
			const titleRequestDefaults = { ...requestDefaults };
			delete titleRequestDefaults.systemPrompt;
			const payloadOptions = { ...titleRequestDefaults, ...this.titleOptions };

			const smartTitle = await provider.generateTitle!(payloadMessages, payloadOptions, controller.signal);
			if (!smartTitle) return;
			if (this.sessionManager.isDeleted(sessionId)) return;

			await this.sessionManager.updateTitle(sessionId, smartTitle);
		} catch (e) {
			console.error("Failed to auto-generate title", e);
		}
	}

	private mergeDefinedOptions(base: Partial<RequestOptions>, patch: Partial<RequestOptions>): Partial<RequestOptions> {
		const next: Partial<RequestOptions> = { ...base };
		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined) {
				delete next[key];
			} else {
				next[key] = value;
			}
		}
		return next;
	}

	private withoutUndefinedOptions(options: Partial<RequestOptions>): Partial<RequestOptions> {
		return this.mergeDefinedOptions({}, options);
	}
}
