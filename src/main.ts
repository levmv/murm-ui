import { ChatEngine } from "./core/chat-engine";
import type { ChatPlugin, ChatProvider, ChatStorage, RequestOptions } from "./core/types";
import { AppRouter, type RouterConfig } from "./router";
import { el, queryOrThrow } from "./utils/dom";

import "./styles/base.css";
import "./styles/sidebar.css";
import "./styles/input.css";
import "./styles/feed.css";
import "./styles/dropdown.css";

import { Feed } from "./components/feed";
import { Input } from "./components/input";
import { Sidebar, type SidebarMenuBuilder } from "./components/sidebar";

const PAGE_SCROLL_CLASS = "mur-chat-page-scroll";

export interface ChatUIConfig {
	container: HTMLElement | string;
	provider: ChatProvider;
	storage: ChatStorage;
	routing?: RouterConfig | boolean;
	titleOptions?: Partial<RequestOptions>;

	enableSidebar?: boolean;
	initialSessionId?: string;

	highlighter?: (code: string, language: string) => string;
	plugins?: (chatApi: ChatEngine) => ChatPlugin[];

	/**
	 * Customizes sidebar item menus. Return the final item list from the provided
	 * defaults; keep side effects inside each item's onClick handler.
	 */
	sidebarMenu?: SidebarMenuBuilder;

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

	private inputComponent!: Input;
	private feedComponent!: Feed;
	private sidebarComponent?: Sidebar;
	private plugins: ChatPlugin[] = [];
	private inputDrafts = new Map<string, string>();

	private elements!: {
		mainArea: HTMLElement;
		sidebarEl: HTMLElement;
		openSidebarBtn: HTMLButtonElement;
		headerTitle: HTMLElement;
		globalError: HTMLElement;
		globalErrorText: HTMLElement;
		globalErrorCloseBtn: HTMLButtonElement;
	};

	private onMainAreaClickBound = () => this.closeSidebar(true);
	private onOpenSidebarBound = (e: MouseEvent) => {
		e.stopPropagation();
		this.openSidebar();
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

		const el =
			typeof this.config.container === "string" ? document.querySelector(this.config.container) : this.config.container;

		if (!el) throw new Error(`Chat container not found: ${this.config.container}`);
		this.container = el as HTMLElement;
		attachPageScrollClass();

		const initialSessionId = this.config.initialSessionId || this.router.getId() || null;

		this.engine = new ChatEngine({
			provider: this.config.provider,
			storage: this.config.storage,
			initialSessionId,
			titleOptions: this.config.titleOptions,
		});

		this.initComponents();
		this.applyConfig();
		this.bindEvents();
	}

	public async destroy() {
		this.router.destroy();
		await this.engine.destroy();

		this.elements.globalErrorCloseBtn.removeEventListener("click", this.onGlobalErrorCloseBound);

		if (this.config.enableSidebar) {
			this.elements.openSidebarBtn.removeEventListener("click", this.onOpenSidebarBound);
			this.elements.mainArea.removeEventListener("click", this.onMainAreaClickBound);
		}

		for (const plugin of this.plugins) {
			if (plugin.destroy) plugin.destroy();
		}

		this.sidebarComponent?.destroy();
		this.feedComponent.destroy();
		this.inputComponent.destroy();
		detachPageScrollClass();
	}

	private initComponents() {
		this.plugins = this.config.plugins ? this.config.plugins(this.engine) : [];
		this.engine.registerPlugins(this.plugins);

		const mainHeader = queryOrThrow<HTMLElement>(this.container, ".mur-main-header");

		this.elements = {} as typeof this.elements;
		this.elements.mainArea = queryOrThrow<HTMLElement>(this.container, ".mur-main-area");
		this.elements.headerTitle = queryOrThrow<HTMLElement>(mainHeader, ".mur-header-title");
		this.elements.globalErrorText = el("span", "mur-global-error-text");
		this.elements.globalErrorCloseBtn = el("button", "mur-global-error-close", {
			type: "button",
			textContent: "x",
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
			if (plugin.onMount) plugin.onMount(pluginCtx);
		}

		this.inputComponent = new Input(
			{
				container: this.container,
				onSubmit: (text) => this.engine.sendMessage(text),
				onStop: () => {
					void this.engine.stopGeneration();
				},
			},
			this.plugins,
		);

		this.feedComponent = new Feed(this.container, {
			highlighter: this.config.highlighter,
			plugins: this.plugins,
		});

		if (this.config.enableSidebar) {
			this.elements.sidebarEl = queryOrThrow<HTMLElement>(this.container, ".mur-sidebar");
			this.elements.openSidebarBtn = queryOrThrow<HTMLButtonElement>(mainHeader, ".mur-open-sidebar-btn");

			this.sidebarComponent = new Sidebar({
				container: this.container,
				engine: this.engine,
				onNewChat: () => {
					void this.engine.sessions.create();
					this.closeSidebar(true);
				},
				onSelectSession: (id) => {
					void this.engine.sessions.switch(id);
					this.closeSidebar(true);
				},
				onLoadMore: () => {
					void this.engine.sessions.loadMore();
				},
				onClose: () => {
					this.closeSidebar(false);
				},
				getSessionHref: (id) => this.router.hrefFor(id),
				sidebarMenu: this.config.sidebarMenu,
			});
			void this.engine.sessions.loadHistory();
		}
	}

	private applyConfig() {
		if (this.config.enableSidebar) {
			const isDesktopClosed = lsGetItem("mur_sidebar_closed") === "true";

			if (isDesktopClosed && window.innerWidth > 768) {
				this.elements.sidebarEl.classList.add("mur-hidden-desktop");
				this.container.classList.add("mur-sidebar-closed");
			}
		}
	}

	private bindEvents() {
		this.elements.globalErrorCloseBtn.addEventListener("click", this.onGlobalErrorCloseBound);

		if (this.config.enableSidebar) {
			this.elements.openSidebarBtn.addEventListener("click", this.onOpenSidebarBound);
			this.elements.mainArea.addEventListener("click", this.onMainAreaClickBound);
		}

		this.router.listen((id) => {
			if (id) {
				void this.engine.sessions.switch(id);
			} else {
				void this.engine.sessions.create();
			}
		});

		this.engine.subscribe(
			(state) => state.sessions,
			(sessions) => {
				const state = this.engine.state;
				if (this.config.enableSidebar && this.sidebarComponent) {
					this.sidebarComponent.renderSessions(
						sessions,
						state.currentSessionId,
						state.hasMoreSessions,
						state.isLoadingSessions,
					);
				}
				this.updateHeaderTitle();
			},
		);

		this.engine.subscribe(
			(state) => (state.hasMoreSessions ? 1 : 0) | (state.isLoadingSessions ? 2 : 0),
			() => {
				const state = this.engine.state;
				if (this.config.enableSidebar && this.sidebarComponent) {
					this.sidebarComponent.renderSessions(
						state.sessions,
						state.currentSessionId,
						state.hasMoreSessions,
						state.isLoadingSessions,
					);
				}
			},
		);

		this.engine.subscribe(
			(state) => state.currentSessionId,
			(currentSessionId) => {
				if (this.config.enableSidebar && this.sidebarComponent) {
					this.sidebarComponent.setActiveSession(currentSessionId);
				}
				this.syncRouterToState();
				this.updateHeaderTitle();
			},
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

		let prevIsGenerating = false;

		// Feed subscribes to the hot lane because stream chunks are applied via
		// in-place mutation and should not run every normal selector per token.
		this.engine.subscribeHot((state) => {
			const isGenerating = state.generatingMessageId !== null;
			const generationStarted = !prevIsGenerating && isGenerating;

			this.feedComponent.update(
				state.messages,
				state.generatingMessageId,
				state.isLoadingSession,
				generationStarted,
				state.error,
			);
			prevIsGenerating = isGenerating;
		});

		let inputSessionId = this.engine.state.currentSessionId;
		this.engine.onChange(
			(state) => state.currentSessionId,
			(currentSessionId) => {
				const draft = this.inputComponent.getText();
				if (draft.length > 0) {
					this.inputDrafts.set(inputSessionId, draft);
				} else {
					this.inputDrafts.delete(inputSessionId);
				}

				inputSessionId = currentSessionId;
				this.inputComponent.setText(this.inputDrafts.get(currentSessionId) ?? "");
				this.inputComponent.focus();
			},
		);

		this.engine.subscribe(
			(state) => (state.generatingMessageId ? 2 : 0) | (state.isLoadingSession ? 1 : 0),
			(bits) => {
				const isGenerating = !!(bits & 2);
				const isLoadingSession = !!(bits & 1);

				this.inputComponent.setGeneratingState(isGenerating, isLoadingSession);
			},
		);

		this.engine.subscribe(
			(state) => state.error,
			(error) => this.renderGlobalError(error),
		);
		this.renderGlobalError(this.engine.state.error);
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

	private updateHeaderTitle() {
		const state = this.engine.state;
		const activeSession = state.sessions.find((s) => s.id === state.currentSessionId);
		const titleText = activeSession ? activeSession.title : "New Chat";

		this.elements.headerTitle.textContent = titleText;

		if (this.config.updateWindowTitle) {
			document.title =
				typeof this.config.updateWindowTitle === "function" ? this.config.updateWindowTitle(titleText) : titleText;
		}
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

	private openSidebar() {
		const isMobile = window.innerWidth <= 768;

		if (isMobile) {
			this.elements.sidebarEl.classList.add("mur-mobile-open");
		} else {
			this.elements.sidebarEl.classList.remove("mur-hidden-desktop");
			this.container.classList.remove("mur-sidebar-closed");
			lsSetItem("mur_sidebar_closed", "false");
		}
	}

	private closeSidebar(isNavigation = false) {
		const isMobile = window.innerWidth <= 768;

		if (isMobile) {
			this.elements.sidebarEl.classList.remove("mur-mobile-open");
			return;
		}

		if (isNavigation) return;

		this.elements.sidebarEl.classList.add("mur-hidden-desktop");
		this.container.classList.add("mur-sidebar-closed");
		lsSetItem("mur_sidebar_closed", "true");
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
		// Ignore
	}
}

function attachPageScrollClass(): void {
	document.documentElement.classList.add(PAGE_SCROLL_CLASS);
}

function detachPageScrollClass(): void {
	document.documentElement.classList.remove(PAGE_SCROLL_CLASS);
}
