import { Composer } from "./components/composer";
import { Sidebar, type SidebarMenuItem } from "./components/sidebar";
import { ChatEngine } from "./core/chat-engine";
import type {
	AgentRunCollapse,
	ChatPlugin,
	ChatProvider,
	ChatSessionMeta,
	ChatStorage,
	CodeHighlighter,
	RequestOptions,
} from "./core/types";
import { MAX_PINNED_SESSIONS } from "./core/types";
import type { ChatLabels } from "./labels";
import { AppRouter, type RouterConfig } from "./router";
import { el, queryOrThrow } from "./utils/dom";
import { ChatView } from "./view/chat-view";

export type SidebarMenuContext = { type: "session"; session: ChatSessionMeta; engine: ChatEngine };
export type SidebarMenuBuilder = (
	defaults: readonly SidebarMenuItem[],
	ctx: SidebarMenuContext,
) => readonly SidebarMenuItem[];
export type DeleteConfirmation = (session: ChatSessionMeta) => boolean | Promise<boolean>;

export interface ChatUIConfig {
	container: HTMLElement | string;
	labels?: Partial<ChatLabels>;
	provider: ChatProvider;
	storage: ChatStorage;
	routing?: RouterConfig | boolean;
	titleOptions?: Partial<RequestOptions>;
	titleInstructions?: string;

	/**
	 * Whether Murm UI owns the viewport and uses page-level scrolling on mobile.
	 * Defaults to true. Pass false when rendering inside a containing element.
	 */
	fullscreen?: boolean;
	enableSidebar?: boolean;
	initialSessionId?: string;

	highlighter?: CodeHighlighter;
	plugins?: (chatApi: ChatEngine) => ChatPlugin[];
	agentRunCollapse?: AgentRunCollapse;
	minAgentRunSteps?: number;

	/**
	 * Customizes sidebar item menus. Return the final item list from the provided
	 * defaults; keep side effects inside each item's onClick handler.
	 */
	sidebarMenu?: SidebarMenuBuilder;
	confirmDelete?: DeleteConfirmation;

	/**
	 * Updates the browser window title to match the active chat.
	 * Pass `true` to use the chat title as-is, or a function for custom formatting.
	 */
	updateWindowTitle?: boolean | ((title: string) => string);
}

export class ChatUI {
	public readonly engine: ChatEngine;
	private container: HTMLElement;
	private config: ChatUIConfig;
	private router: AppRouter;

	private composer!: Composer;
	private view!: ChatView;
	private sidebar?: Sidebar<ChatSessionMeta>;
	private plugins: ChatPlugin[] = [];
	private destroyPromise?: Promise<void>;

	private elements!: {
		mainArea: HTMLElement;
		globalError: HTMLElement;
		globalErrorText: HTMLElement;
		globalErrorCloseBtn: HTMLButtonElement;
	};

	private onGlobalErrorCloseBound = (e: MouseEvent) => {
		e.stopPropagation();
		this.engine.clearError();
	};

	constructor(config: ChatUIConfig) {
		this.config = { enableSidebar: true, ...config };

		let routerConfig: RouterConfig = { type: "hash" };
		if (this.config.routing === false) {
			routerConfig = { type: "none" };
		} else if (typeof this.config.routing === "object") {
			routerConfig = this.config.routing;
		}

		this.router = new AppRouter(routerConfig);

		const container =
			typeof this.config.container === "string" ? document.querySelector(this.config.container) : this.config.container;

		if (!container) throw new Error(`Chat container not found: ${this.config.container}`);
		this.container = container as HTMLElement;

		const initialSessionId = this.config.initialSessionId || this.router.getId() || null;

		this.engine = new ChatEngine({
			provider: this.config.provider,
			storage: this.config.storage,
			initialSessionId,
			titleOptions: this.config.titleOptions,
			titleInstructions: this.config.titleInstructions,
		});

		this.initComponents();
		this.bindEvents();
	}

	public destroy(): Promise<void> {
		if (this.destroyPromise) return this.destroyPromise;
		this.router.destroy();
		// The engine detaches state listeners synchronously. Release UI resources
		// now, even if flushing storage takes time or closing it rejects.
		this.destroyPromise = this.engine.destroy();

		this.elements.globalErrorCloseBtn.removeEventListener("click", this.onGlobalErrorCloseBound);
		this.elements.globalError.remove();

		this.sidebar?.destroy();
		this.view.destroy();
		this.composer.destroy();
		for (const plugin of this.plugins) {
			try {
				plugin.destroy?.();
			} catch (error) {
				console.error(`Plugin "${plugin.name}" failed during destroy`, error);
			}
		}
		return this.destroyPromise;
	}

	private initComponents() {
		this.plugins = this.config.plugins ? this.config.plugins(this.engine) : [];
		this.engine.registerPlugins(this.plugins);

		this.elements = {} as typeof this.elements;
		this.elements.mainArea = queryOrThrow<HTMLElement>(this.container, ".mur-main-area");
		this.elements.globalErrorText = el("span", "mur-global-error-text");
		this.elements.globalErrorCloseBtn = el("button", "mur-global-error-close", {
			type: "button",
			textContent: "×",
			title: "Dismiss error",
		});
		this.elements.globalErrorCloseBtn.setAttribute("aria-label", "Dismiss error");
		this.elements.globalError = el(
			"div",
			"mur-global-error",
			{
				hidden: true,
			},
			[this.elements.globalErrorText, this.elements.globalErrorCloseBtn],
		);
		this.elements.globalError.setAttribute("role", "alert");
		this.elements.mainArea.appendChild(this.elements.globalError);

		const pluginCtx = {
			engine: this.engine,
			container: this.container,
		};

		for (const plugin of this.plugins) {
			if (!plugin.onMount) continue;
			try {
				plugin.onMount(pluginCtx);
			} catch (error) {
				console.error(`Plugin "${plugin.name}" failed during onMount`, error);
			}
		}

		this.view = new ChatView({
			container: this.container,
			conversation: this.engine.conversation,
			reuseMarkup: true,
			fullscreen: this.config.fullscreen !== false,
			labels: this.config.labels,
			highlighter: this.config.highlighter,
			plugins: this.plugins.map(({ name, renderers, getActionButtons }) => ({ name, renderers, getActionButtons })),
			agentRunCollapse: this.config.agentRunCollapse,
			minAgentRunSteps: this.config.minAgentRunSteps,
			onReachTop: () => this.engine.sessions.loadOlderMessages(),
		});
		this.composer = new Composer({
			container: this.container,
			form: queryOrThrow<HTMLFormElement>(this.container, ".mur-chat-form"),
			plugins: this.plugins,
			labels: this.config.labels,
			onSubmit: ({ conversationId, text, blocks }) => {
				if (conversationId !== this.engine.state.currentSessionId) return false;
				return this.engine.sendMessage(text, blocks);
			},
			onStop: () => this.engine.stopGeneration(),
		});

		if (this.config.enableSidebar) {
			this.sidebar = new Sidebar<ChatSessionMeta>({
				container: this.container,
				reuseMarkup: true,
				collapsed: lsGetItem("mur_sidebar_closed") === "true",
				onCollapse: (closed) => lsSetItem("mur_sidebar_closed", String(closed)),
				onNew: async () => {
					await this.engine.sessions.create();
				},
				onSelect: (id) => this.engine.sessions.switch(id),
				onRename: (id, title) => this.engine.sessions.updateTitle(id, title),
				onPin: (id, pinned) => this.engine.sessions.updatePinned(id, pinned),
				onDelete: (id) => this.engine.sessions.delete(id),
				onLoadMore: () => this.engine.sessions.loadMore(),
				getHref: (id) => this.router.hrefFor(id),
				pinLimit: MAX_PINNED_SESSIONS,
				menu: this.config.sidebarMenu
					? (defaults, session) => this.config.sidebarMenu!(defaults, { type: "session", session, engine: this.engine })
					: undefined,
				confirmDelete: this.config.confirmDelete,
			});
			void this.engine.sessions.loadHistory();
		}
	}

	private bindEvents() {
		this.elements.globalErrorCloseBtn.addEventListener("click", this.onGlobalErrorCloseBound);

		this.router.listen((id) => {
			if (id) {
				void this.engine.sessions.switch(id);
			} else {
				void this.engine.sessions.create();
			}
		});

		const titleEl = this.container.querySelector<HTMLElement>(".mur-header-title");
		const windowTitle = this.config.updateWindowTitle;
		if (titleEl || windowTitle) {
			this.engine.subscribe(
				(state) => state.sessions.find((session) => session.id === state.currentSessionId)?.title ?? "New Chat",
				(title) => {
					if (titleEl) titleEl.textContent = title;
					if (windowTitle) document.title = typeof windowTitle === "function" ? windowTitle(title) : title;
				},
			);
		}

		const inputCapabilities = () => {
			const state = this.engine.state;
			return {
				canSubmit: !state.isLoadingSession && !state.generatingMessageId,
				canEdit: true,
				canStop: Boolean(state.generatingMessageId),
			};
		};

		const syncSidebar = () => {
			const state = this.engine.state;
			this.sidebar?.update({
				sessions: state.sessions,
				activeId: state.currentSessionId,
				hasMore: state.hasMoreSessions,
				loading: state.isLoadingSessions,
			});
		};
		this.engine.subscribe((state) => state.sessions, syncSidebar);
		this.engine.subscribe((state) => (state.hasMoreSessions ? 1 : 0) | (state.isLoadingSessions ? 2 : 0), syncSidebar);

		this.engine.subscribe(
			(state) => state.currentSessionId,
			(currentSessionId) => {
				if (this.config.enableSidebar && this.sidebar) {
					this.sidebar.setActive(currentSessionId);
				}
				this.syncRouterToState();
				this.composer.setConversation(currentSessionId, inputCapabilities());
			},
		);
		this.engine.onChange(
			(state) => state.currentSessionId,
			() => this.composer.focus(),
		);

		this.engine.subscribe(
			(state) =>
				(state.isLoadingSession ? 1 : 0) | (state.error !== null ? 2 : 0) | (state.messages.length > 0 ? 4 : 0),
			() => this.syncRouterToState(),
		);

		this.engine.subscribe(
			(state) => (state.isLoadingSession ? null : state.messages.length === 0),
			(isEmpty) => {
				if (isEmpty !== null) {
					this.container.classList.toggle("mur-chat-empty", isEmpty);
				}
			},
		);

		this.engine.subscribe(
			(state) => (state.isLoadingSession ? 1 : 0) | (state.generatingMessageId ? 2 : 0),
			() => {
				const state = this.engine.state;
				this.composer.setCapabilities(inputCapabilities());
				this.view.setLoading(state.isLoadingSession);
				if (state.generatingMessageId) this.view.scrollToLatest();
			},
		);
		this.engine.subscribe(
			(state) => (state.hasMoreMessages ? 1 : 0) | (state.isLoadingMessages ? 2 : 0),
			() => {
				const state = this.engine.state;
				this.view.setOlderMessagesState(state.hasMoreMessages, state.isLoadingMessages);
			},
		);

		this.engine.subscribe(
			(state) => state.error,
			(error) => this.renderGlobalError(error),
		);
	}

	private renderGlobalError(error: { message: string; id?: string } | null) {
		if (!error || error.id) {
			this.elements.globalError.hidden = true;
			this.elements.globalErrorText.textContent = "";
			return;
		}

		this.elements.globalErrorText.textContent = error.message;
		this.elements.globalError.hidden = false;
	}

	private syncRouterToState() {
		const state = this.engine.state;
		const currentUrlId = this.router.getId();

		const isSavedSession = state.sessions.some((s) => s.id === state.currentSessionId);
		const shouldHaveUrlId =
			state.messages.length > 0 ||
			isSavedSession ||
			(state.isLoadingSession && currentUrlId === state.currentSessionId);

		const targetId = shouldHaveUrlId ? state.currentSessionId : null;

		if (currentUrlId === targetId) return;

		// If we fell back to an empty chat due to a loading error (e.g., broken link),
		// use replace so we don't trap the user's Back button.
		const isErrorFallback = !shouldHaveUrlId && state.error !== null;
		this.router.setUrl(targetId, isErrorFallback);
	}
}

function lsGetItem(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function lsSetItem(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// A storage failure should not prevent toggling the sidebar.
	}
}
