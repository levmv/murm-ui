import { Feed } from "../components/feed";
import { ConversationModel } from "../core/conversation";
import type {
	ConversationInvalidation,
	ConversationSnapshot,
	ConversationState,
	ConversationUpdate,
} from "../core/conversation-types";
import type {
	AgentRunCollapse,
	BlockAction,
	ChatPlugin,
	CodeHighlighter,
	DeepReadonly,
	Message,
	MessagePlugin,
} from "../core/types";
import { type ChatLabels, defaultLabels } from "../labels";
import { el, queryOrThrow } from "../utils/dom";

const PAGE_SCROLL_CLASS = "mur-chat-page-scroll";
let pageScrollAttachCount = 0;

export interface ChatViewConfig {
	/** Optional syntax highlighting for built-in Markdown code blocks. */
	highlighter?: CodeHighlighter;
	labels?: Partial<ChatLabels>;
	container: HTMLElement | string;
	/** Share an existing conversation, e.g. engine.conversation. The view does not own its lifecycle. */
	conversation?: ConversationModel;
	/** Use the existing .mur-main-area, .mur-chat-scroll-area and .mur-chat-history. */
	reuseMarkup?: boolean;
	/** Fill the viewport and use page scrolling on mobile. Defaults to false. */
	fullscreen?: boolean;
	/** Optional content displayed when the conversation has no messages. */
	emptyState?: string | HTMLElement;
	/** Display hooks only. ChatUI's composer/provider hooks are ignored with a warning. */
	plugins?: MessagePlugin[];
	agentRunCollapse?: AgentRunCollapse;
	minAgentRunSteps?: number;
	showReasoning?: boolean;
	onAction?: (command: BlockAction) => void | Promise<void>;
	/** The controller loads history and calls setOlderMessagesState/prependMessages. */
	onReachTop?: () => void;
	/** Enables block actions and mutating message actions. Defaults to true. */
	canAct?: boolean;
}

/**
 * Displays a conversation. The application owns provider calls, persistence
 * and the ordering of incoming updates.
 */
export class ChatView {
	private readonly model: ConversationModel;
	readonly element: HTMLElement;
	private readonly labels: Readonly<ChatLabels>;
	private readonly emptyState?: HTMLElement;
	private readonly feed: Feed;
	private readonly errorEl: HTMLElement;
	private readonly unsubscribe: () => void;
	private pendingFrame: number | null = null;
	private pendingChange: ConversationInvalidation | null = null;
	private conversationId = "";
	private canAct: boolean;
	private destroyed = false;
	private loading = false;
	private readonly ownsElement: boolean;
	private readonly wasEmbedded: boolean;

	constructor(private readonly config: ChatViewConfig) {
		this.canAct = config.canAct ?? true;
		this.model = config.conversation ?? new ConversationModel();
		const host =
			typeof config.container === "string" ? document.querySelector<HTMLElement>(config.container) : config.container;
		if (!host) throw new Error(`Chat container not found: ${config.container}`);
		this.ownsElement = !config.reuseMarkup;
		for (const plugin of config.plugins ?? []) {
			const unsupported = CHAT_ONLY_HOOKS.filter((hook) => typeof (plugin as ChatPlugin)[hook] === "function");
			if (unsupported.length) {
				console.warn(
					`ChatView plugin "${plugin.name}" ignores ChatUI-only hooks: ${unsupported.join(", ")}. Only message display hooks run in ChatView.`,
				);
			}
		}
		this.labels = config.labels ? { ...defaultLabels, ...config.labels } : defaultLabels;
		const history = config.reuseMarkup
			? queryOrThrow<HTMLElement>(host, ".mur-chat-history")
			: el("div", "mur-chat-history");
		history.setAttribute("role", "log");
		history.setAttribute("aria-live", "polite");
		const scrollArea = config.reuseMarkup
			? queryOrThrow<HTMLElement>(host, ".mur-chat-scroll-area")
			: el("div", "mur-chat-scroll-area", null, [history]);
		this.errorEl = el("div", "mur-view-error", { hidden: true });
		this.errorEl.setAttribute("role", "alert");
		const main = config.reuseMarkup
			? queryOrThrow<HTMLElement>(host, ".mur-main-area")
			: el("div", "mur-main-area", null, [scrollArea]);
		main.appendChild(this.errorEl);
		if (config.emptyState !== undefined) {
			this.emptyState = el("div", "mur-view-empty");
			if (typeof config.emptyState === "string") this.emptyState.textContent = config.emptyState;
			else this.emptyState.appendChild(config.emptyState);
			scrollArea.prepend(this.emptyState);
		}
		this.element = config.reuseMarkup ? (host as HTMLElement) : el("div", "mur-app mur-view", null, [main]);
		this.wasEmbedded = this.element.classList.contains("mur-app-embedded");
		this.element.classList.toggle("mur-app-embedded", !config.fullscreen);
		if (this.ownsElement) host.appendChild(this.element);

		this.feed = new Feed(this.element, {
			highlighter: config.highlighter,
			plugins: config.plugins ?? [],
			labels: this.labels,
			fullscreen: config.fullscreen ?? false,
			agentRunCollapse: config.agentRunCollapse,
			minAgentRunSteps: config.minAgentRunSteps,
			showReasoning: config.showReasoning,
			canAct: () => this.canAct,
			getConversationId: () => this.model.state.id,
			onAction: (command) => {
				void this.dispatch(command);
			},
			onReachTop: config.onReachTop,
		});
		this.unsubscribe = this.model.subscribe((change) => this.onChange(change));
		this.onChange({ messageIds: new Set(), structural: true, reset: true });
		if (config.fullscreen) {
			pageScrollAttachCount++;
			document.documentElement.classList.add(PAGE_SCROLL_CLASS);
		}
	}

	/** Live read-only display state; copy it if a durable snapshot is needed. */
	get state(): DeepReadonly<ConversationState> {
		return this.model.state;
	}

	setConversation(snapshot: ConversationSnapshot): void {
		this.assertAlive();
		this.model.setConversation(snapshot);
	}

	apply(update: ConversationUpdate): boolean {
		this.assertAlive();
		return this.model.apply(update);
	}

	prependMessages(conversationId: string, messages: Message[]): boolean {
		this.assertAlive();
		return this.model.prepend(conversationId, messages);
	}

	/** Loading replaces the transcript with a spinner without changing its data. */
	setLoading(loading: boolean): void {
		this.assertAlive();
		if (this.loading === loading) return;
		this.loading = loading;
		this.schedule({ messageIds: new Set(), structural: true });
	}

	scrollToLatest(): void {
		this.assertAlive();
		this.feed.scrollToLatest();
	}

	/** Update the indicator when onReachTop delegates pagination to an external controller. */
	setOlderMessagesState(hasMore: boolean, loading: boolean): void {
		this.assertAlive();
		this.feed.setOlderMessagesState(hasMore, loading);
	}

	setCanAct(canAct: boolean): void {
		this.assertAlive();
		if (this.canAct === canAct) return;
		this.canAct = canAct;
		this.schedule({ messageIds: new Set(this.model.state.messages.map((message) => message.id)), structural: false });
	}

	setError(error: string | null): void {
		this.assertAlive();
		this.errorEl.hidden = !error;
		this.errorEl.textContent = error ?? "";
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		if (this.config.fullscreen && --pageScrollAttachCount === 0)
			document.documentElement.classList.remove(PAGE_SCROLL_CLASS);
		this.unsubscribe();
		if (this.pendingFrame !== null) cancelAnimationFrame(this.pendingFrame);
		this.pendingFrame = null;
		this.pendingChange = null;
		this.feed.destroy();
		for (const plugin of this.config.plugins ?? []) {
			try {
				plugin.destroy?.();
			} catch (error) {
				console.error(`Plugin "${plugin.name}" failed during destroy`, error);
			}
		}
		if (this.ownsElement) this.element.remove();
		else {
			this.element.classList.toggle("mur-app-embedded", this.wasEmbedded);
			this.errorEl.remove();
			this.emptyState?.remove();
		}
	}

	private onChange(change: ConversationInvalidation): void {
		if (change.reset) {
			const { id } = this.model.state;
			if (id !== this.conversationId) this.feed.reset();
			this.conversationId = id;
			this.setError(null);
		}
		this.schedule(change);
	}

	private schedule(change: ConversationInvalidation): void {
		if (!this.pendingChange) this.pendingChange = { messageIds: new Set(), structural: false };
		for (const id of change.messageIds) this.pendingChange.messageIds.add(id);
		this.pendingChange.structural ||= change.structural;
		if (this.pendingFrame !== null) return;
		this.pendingFrame = requestAnimationFrame(() => {
			this.pendingFrame = null;
			const pending = this.pendingChange!;
			this.pendingChange = null;
			if (this.destroyed) return;
			if (pending.structural || pending.messageIds.size) {
				this.feed.update(this.model.state.messages, {
					streamingMessageIds: this.model.streamingMessageIds,
					dirtyMessageIds: pending.structural ? undefined : pending.messageIds,
					loading: this.loading,
				});
			}
			if (pending.structural && this.emptyState)
				this.emptyState.hidden = this.loading || this.model.state.messages.length > 0;
		});
	}

	private async dispatch(command: BlockAction): Promise<void> {
		if (this.destroyed || command.conversationId !== this.model.state.id || !this.canAct) return;
		const message = this.model.getMessage(command.messageId);
		if (!message?.blocks.some((block) => block.id === command.blockId)) return;
		const snapshot = this.model.state;
		this.setError(null);
		try {
			await this.config.onAction?.(command);
		} catch (error) {
			if (!this.destroyed && snapshot === this.model.state) this.setError(errorText(error));
		}
	}

	private assertAlive(): void {
		if (this.destroyed) throw new Error("ChatView has been destroyed");
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const CHAT_ONLY_HOOKS = ["onMount", "beforeSubmit", "mountComposer"] as const satisfies readonly (keyof Omit<
	ChatPlugin,
	keyof MessagePlugin
>)[];
