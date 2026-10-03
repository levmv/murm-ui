import { uuidv7 } from "../utils/uuid";
import { ConversationModel } from "./conversation";
import type { ConversationChange } from "./conversation-types";
import { cloneBlock, cloneMessages, dropEphemeralMessages } from "./msg-utils";
import { type ChatSessions, SessionManager, type SessionState } from "./session-manager";
import { Store } from "./store";
import type {
	ChatPlugin,
	ChatProvider,
	ChatRequest,
	ChatRequestDefaults,
	ChatState,
	ChatStorage,
	ContentBlock,
	Message,
	ReadonlyChatRequest,
	RequestOptions,
} from "./types";

export interface ChatEngineConfig {
	provider: ChatProvider;
	storage: ChatStorage;
	initialSessionId?: string | null;
	titleOptions?: Partial<RequestOptions>;
	titleInstructions?: string;
}

interface ActiveGeneration {
	id: string;
	sessionId: string;
	runId: string;
	controller: AbortController;
	provider: ChatProvider;
	requestDefaults: ChatRequestDefaults;
}

export class ChatEngine {
	readonly conversation = new ConversationModel();
	private store: Store<SessionState>;
	private readonly sessionManager: SessionManager;
	public readonly sessions: ChatSessions;

	private provider: ChatProvider;
	private plugins: ChatPlugin[] = [];
	private requestDefaults: ChatRequestDefaults = { options: {} };
	private titleOptions: Partial<RequestOptions> = {};
	private titleInstructions?: string;
	private activeGeneration: ActiveGeneration | null = null;
	private autoTitleControllers = new Set<AbortController>();
	private isDestroyed = false;
	private destroyPromise?: Promise<void>;

	constructor(config: ChatEngineConfig) {
		this.provider = config.provider;
		this.titleOptions = this.mergeRequestOptions({}, config.titleOptions ?? {});
		this.titleInstructions = config.titleInstructions;

		const startingId = config.initialSessionId || uuidv7();

		this.conversation.setConversation({ id: startingId, messages: [] });
		this.store = new Store<SessionState>({
			sessions: [],
			hasMoreSessions: false,
			isLoadingSession: !!config.initialSessionId,
			isLoadingSessions: false,
			isLoadingMessages: false,
			olderCursor: null,
			error: null,
		});
		this.sessionManager = new SessionManager({
			store: this.store,
			conversation: this.conversation,
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
		const { olderCursor, ...session } = this.store.get();
		return {
			...session,
			currentSessionId: this.conversation.state.id,
			messages: this.conversation.state.messages,
			generatingMessageId: this.activeGeneration?.id ?? null,
			hasMoreMessages: olderCursor !== null,
		};
	}

	public subscribe<U>(selector: (state: ChatState) => U, listener: (selectedState: U) => void): () => void {
		return this.store.subscribe(() => selector(this.state), listener);
	}

	public onChange<U>(selector: (state: ChatState) => U, listener: (selectedState: U) => void): () => void {
		return this.store.onChange(() => selector(this.state), listener);
	}

	private get isBusy() {
		return this.activeGeneration !== null;
	}

	public async setProvider(newProvider: ChatProvider) {
		if (this.isDestroyed) return;
		this.provider = newProvider;
		if (this.isBusy) await this.stopGeneration();
	}

	public clearError() {
		const id = this.state.error?.id;
		const message = id ? this.conversation.getMessage(id) : undefined;
		if (message?.error)
			this.conversation.apply({
				conversationId: this.conversation.state.id,
				changes: [{ type: "message.state", messageId: message.id, status: "complete" }],
			});
		this.store.set({ error: null });
	}

	public sendMessage(content: string, blocks: ContentBlock[] = []): boolean {
		if (this.isDestroyed || this.isBusy || this.state.isLoadingSession) return false;

		const now = Date.now();
		const userMessageId = uuidv7();

		const userMessage: Message = {
			id: userMessageId,
			role: "user",
			blocks: [...blocks.map(cloneBlock), ...(content ? [{ id: uuidv7(), type: "text" as const, text: content }] : [])],
			runId: userMessageId,
			createdAt: now,
			updatedAt: now,
		};

		if (userMessage.blocks.length === 0) return false;

		this.startGeneration(
			userMessage,
			this.state.messages.filter((message) => message.ephemeral),
		);
		return true;
	}

	public editAndResubmit(messageId: string, newContent: string): boolean {
		if (this.isDestroyed || this.isBusy) return false;

		const currentMessages = this.state.messages;
		const targetIndex = currentMessages.findIndex((m) => m.id === messageId);

		if (targetIndex === -1) return false;
		if (currentMessages[targetIndex].role !== "user") return false;

		// Keep attachments and other non-text blocks when replacing the prompt.
		const original = currentMessages[targetIndex];
		const preservedBlocks = original.blocks.filter((b) => b.type !== "text");
		const textBlocks = newContent ? [{ id: uuidv7(), type: "text" as const, text: newContent }] : [];
		const finalBlocks = [...preservedBlocks, ...textBlocks];
		const now = Date.now();

		if (finalBlocks.length === 0) return false;

		const edited = {
			...original,
			blocks: finalBlocks,
			runId: original.runId ?? original.id,
			createdAt: original.createdAt ?? now,
			updatedAt: now,
		};

		this.startGeneration(
			edited,
			currentMessages.filter((message, index) => index > targetIndex || message.ephemeral),
		);
		return true;
	}

	/** Replaces the current history and saves it to storage. */
	public async setMessages(messages: Message[]): Promise<boolean> {
		if (this.isDestroyed) return false;
		if (this.isBusy) {
			console.warn("Cannot modify history while the AI is generating a response.");
			return false;
		}

		this.conversation.setConversation({ id: this.conversation.state.id, messages });
		this.store.set({ isLoadingSession: false, isLoadingMessages: false, olderCursor: null, error: null });
		return await this.persistCurrentSession();
	}

	/**
	 * Sets defaults for subsequent requests. instructions and tools are model inputs;
	 * options contains provider-specific parameters.
	 */
	public setRequestDefaults(defaults: Partial<ChatRequestDefaults>) {
		this.requestDefaults = {
			...this.requestDefaults,
			...defaults,
			options: this.mergeRequestOptions(this.requestDefaults.options ?? {}, defaults.options ?? {}),
		};
	}

	public setTitleOptions(options: Partial<RequestOptions>) {
		this.titleOptions = this.mergeRequestOptions(this.titleOptions, options);
	}

	public setTitleInstructions(instructions: string | undefined) {
		this.titleInstructions = instructions;
	}

	public async stopGeneration() {
		const generation = this.activeGeneration;
		if (!generation) return;

		generation.controller.abort();
		await this.finalizeGeneration(generation.id, true);
	}

	public destroy(): Promise<void> {
		if (this.destroyPromise) return this.destroyPromise;
		this.isDestroyed = true;
		this.store.clearAllListeners();
		this.abortAutoTitles();
		this.destroyPromise = this.stopGeneration().finally(() => this.sessionManager.close());
		return this.destroyPromise;
	}

	private startGeneration(userMessage: Message, removed: Message[]) {
		const generationId = uuidv7();
		const sessionId = this.state.currentSessionId;
		const runId = userMessage.runId ?? userMessage.id;

		// Show a loading state before the provider emits its first block.
		const now = Date.now();
		const assistantMessage: Message = {
			id: generationId,
			role: "assistant",
			blocks: [],
			runId,
			createdAt: now,
			updatedAt: now,
			ephemeral: true,
			status: "streaming",
		};
		const changes: ConversationChange[] = removed.map((message) => ({ type: "message.remove", messageId: message.id }));
		changes.push({ type: "message.put", message: userMessage }, { type: "message.put", message: assistantMessage });
		const generation: ActiveGeneration = {
			id: generationId,
			sessionId,
			runId,
			controller: new AbortController(),
			provider: this.provider,
			requestDefaults: this.cloneRequestDefaults(),
		};
		this.activeGeneration = generation;
		// Reject malformed input synchronously so the composer keeps its draft.
		try {
			this.conversation.apply({ conversationId: sessionId, changes });
		} catch (error) {
			this.activeGeneration = null;
			throw error;
		}
		this.store.set({ error: null });
		void this.runGeneration(generation);
	}

	private async runGeneration(generation: ActiveGeneration) {
		const { id: generationId, sessionId, runId, provider, controller, requestDefaults } = generation;
		const { signal } = controller;
		let error: string | undefined;
		try {
			const contextMessages = dropEphemeralMessages(this.conversation.state.messages);
			const preparedRequest = await this.prepareRequest(contextMessages, signal, requestDefaults);
			if (signal.aborted) return;
			await provider.streamChat({ ...preparedRequest, messageId: generationId, runId }, (changes) => {
				if (signal.aborted || this.activeGeneration?.id !== generationId) return;
				this.conversation.apply({ conversationId: sessionId, changes });
			});
		} catch (err: unknown) {
			if (signal.aborted) return;

			error =
				err instanceof Error
					? err.message
					: typeof err === "object" && err !== null
						? JSON.stringify(err)
						: String(err);
		} finally {
			await this.finalizeGeneration(generationId, signal.aborted, error);
		}
	}

	private async prepareRequest(
		messages: Message[],
		signal: AbortSignal,
		requestDefaults: ChatRequestDefaults = this.requestDefaults,
	): Promise<ChatRequest> {
		const preparedRequest: ChatRequest = {
			messages: [...messages],
			instructions: requestDefaults.instructions,
			tools: requestDefaults.tools ? [...requestDefaults.tools] : undefined,
			options: { ...requestDefaults.options },
			signal,
		};

		for (const plugin of this.plugins) {
			if (signal.aborted) return preparedRequest;

			if (plugin.beforeSubmit) {
				const request: ReadonlyChatRequest = {
					messages: [...preparedRequest.messages],
					instructions: preparedRequest.instructions,
					tools: preparedRequest.tools ? [...preparedRequest.tools] : undefined,
					options: { ...preparedRequest.options },
					signal,
				};
				const patch = await plugin.beforeSubmit(request);
				if (signal.aborted) return preparedRequest;

				if (patch) {
					if (patch.messages) preparedRequest.messages = patch.messages;
					if (Object.hasOwn(patch, "instructions")) {
						preparedRequest.instructions = patch.instructions;
					}
					if (Object.hasOwn(patch, "tools")) {
						preparedRequest.tools = patch.tools ? [...patch.tools] : undefined;
					}
					if (patch.options) {
						preparedRequest.options = this.mergeRequestOptions(
							preparedRequest.options,
							patch.options,
						) as RequestOptions;
					}
				}
			}
		}

		preparedRequest.messages = dropEphemeralMessages(preparedRequest.messages);

		return preparedRequest;
	}

	private async finalizeGeneration(generationId: string, wasAborted = false, error?: string) {
		const generation = this.activeGeneration;
		if (generation?.id !== generationId) return;
		this.activeGeneration = null;
		const changes: ConversationChange[] = [];
		let errorMessageId: string | undefined;
		const now = Date.now();
		for (const message of this.conversation.state.messages) {
			if (message.runId !== generation.runId || message.status !== "streaming") continue;
			if (wasAborted && message.ephemeral) {
				changes.push({ type: "message.remove", messageId: message.id });
				continue;
			}
			for (const block of message.blocks) {
				if (block.type === "tool_call" && block.status === "streaming")
					changes.push({
						type: "tool.update",
						messageId: message.id,
						blockId: block.id,
						status: error || wasAborted ? "error" : "complete",
					});
			}
			changes.push({
				type: "message.state",
				messageId: message.id,
				status: error ? "error" : "complete",
				error,
				updatedAt: now,
			});
			errorMessageId = message.id;
		}
		this.conversation.apply({
			conversationId: generation.sessionId,
			changes,
		});
		try {
			// Capture and enqueue before notifying idle: a subscriber may navigate.
			const finalMessages = cloneMessages(this.state.messages);
			const persistentMessages = dropEphemeralMessages(finalMessages);
			const saving = this.sessionManager.persistSessionSnapshot(generation.sessionId, finalMessages);
			this.store.set({ error: error ? { message: error, ...(errorMessageId ? { id: errorMessageId } : {}) } : null });
			const saved = await saving;

			if (!saved) return;

			// Generate a title after the first successful assistant reply.
			if (!error && !wasAborted && generation.provider.generateTitle) {
				const assistantReplyCount = persistentMessages.filter(
					(m) => m.role === "assistant" && m.blocks.length > 0,
				).length;

				if (assistantReplyCount === 1) {
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

	private async persistCurrentSession(): Promise<boolean> {
		const { currentSessionId, messages } = this.state;
		return await this.sessionManager.persistSessionSnapshot(currentSessionId, cloneMessages(messages));
	}

	private async triggerAutoTitle(
		sessionId: string,
		messages: Message[],
		provider: ChatProvider,
		requestDefaults: ChatRequestDefaults,
	) {
		if (this.isDestroyed || this.sessionManager.isDeleted(sessionId)) return;

		const controller = new AbortController();
		this.autoTitleControllers.add(controller);

		try {
			const payloadMessages = dropEphemeralMessages(messages);
			const payloadOptions = { ...requestDefaults.options, ...this.titleOptions };
			const titleRequest: ChatRequest = {
				messages: payloadMessages,
				instructions: this.titleInstructions,
				options: payloadOptions,
				signal: controller.signal,
			};

			const title = await provider.generateTitle!(titleRequest);
			if (!title) return;
			if (controller.signal.aborted || this.isDestroyed || this.sessionManager.isDeleted(sessionId)) return;

			await this.sessionManager.updateTitle(sessionId, title);
		} catch (e) {
			if (controller.signal.aborted) return;
			console.error("Failed to auto-generate title", e);
		} finally {
			this.autoTitleControllers.delete(controller);
		}
	}

	private abortAutoTitles(): void {
		for (const controller of this.autoTitleControllers) {
			controller.abort();
		}
		this.autoTitleControllers.clear();
	}

	/** Explicit undefined values remove inherited options. */
	private mergeRequestOptions(base: Partial<RequestOptions>, patch: Partial<RequestOptions>): Partial<RequestOptions> {
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

	private cloneRequestDefaults(defaults: ChatRequestDefaults = this.requestDefaults): ChatRequestDefaults {
		return {
			instructions: defaults.instructions,
			tools: defaults.tools ? [...defaults.tools] : undefined,
			options: { ...defaults.options },
		};
	}
}
