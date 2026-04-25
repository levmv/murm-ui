import { ChatEngine } from "./core/chat-engine";
import type { ChatPlugin, ChatProvider, ChatStorage } from "./core/types";
import { AppRouter, type RouterConfig } from "./router";
import { queryOrThrow } from "./utils/dom";

import "./styles/base.css";
import "./styles/sidebar.css";
import "./styles/input.css";
import "./styles/feed.css";

import { Feed } from "./components/feed";
import { Input } from "./components/input";
import { Sidebar } from "./components/sidebar";

export interface ChatUIConfig {
	container: HTMLElement | string;
	provider: ChatProvider;
	storage: ChatStorage;
	routing?: RouterConfig | boolean;

	enableSidebar?: boolean;
	initialSessionId?: string;

	highlighter?: (code: string, language: string) => string;
	plugins?: (chatApi: ChatEngine) => ChatPlugin[];
}

export class ChatUI {
	public declare readonly engine: ChatEngine;
	private declare container: HTMLElement;
	private declare config: ChatUIConfig;
	private declare router: AppRouter;

	private declare inputComponent: Input;
	private declare feedComponent: Feed;
	private sidebarComponent?: Sidebar;
	private plugins: ChatPlugin[] = [];

	private elements!: {
		mainArea: HTMLElement;
		sidebarEl: HTMLElement;
		openSidebarBtn: HTMLButtonElement;
		headerTitle: HTMLElement;
	};

	private onMainAreaClickBound = () => this.closeSidebar(true);
	private onOpenSidebarBound = (e: MouseEvent) => {
		e.stopPropagation();
		this.openSidebar();
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

		const initialSessionId = this.config.initialSessionId || this.router.getId() || null;

		this.engine = new ChatEngine({
			provider: this.config.provider,
			storage: this.config.storage,
			initialSessionId,
		});

		this.initComponents();
		this.applyConfig();
		this.bindEvents();
	}

	public async destroy() {
		this.router.destroy();
		await this.engine.destroy();

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
	}

	private initComponents() {
		this.plugins = this.config.plugins ? this.config.plugins(this.engine) : [];
		this.engine.registerPlugins(this.plugins);

		const mainHeader = queryOrThrow<HTMLElement>(this.container, ".mur-main-header");

		this.elements = {} as typeof this.elements;
		this.elements.mainArea = queryOrThrow<HTMLElement>(this.container, ".mur-main-area");
		this.elements.headerTitle = queryOrThrow<HTMLElement>(mainHeader, ".mur-header-title");

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
				onSubmit: async (text) => await this.engine.sendMessage(text),
				onStop: () => this.engine.stopGeneration(),
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
				onNewChat: () => {
					this.engine.createNewSession();
					this.closeSidebar(true);
				},
				onSelectSession: (id) => {
					this.engine.switchSession(id);
					this.closeSidebar(true);
				},
				onDeleteSession: (id) => {
					this.engine.deleteSession(id);
				},
				onLoadMore: () => {
					this.engine.loadMoreSessions();
				},
				onClose: () => {
					this.closeSidebar(false);
				},
				getSessionHref: (id) => this.router.hrefFor(id),
			});
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
		const store = this.engine.store;
		if (this.config.enableSidebar) {
			this.elements.openSidebarBtn.addEventListener("click", this.onOpenSidebarBound);
			this.elements.mainArea.addEventListener("click", this.onMainAreaClickBound);
		}

		this.router.listen((id) => {
			if (id) {
				this.engine.switchSession(id);
			} else {
				this.engine.createNewSession();
			}
		});

		store.subscribe(
			(state) => state.sessions,
			(sessions) => {
				const state = store.get();
				if (this.config.enableSidebar && this.sidebarComponent) {
					this.sidebarComponent.renderSessions(sessions, state.currentSessionId, state.hasMoreSessions);
				}
				this.updateHeaderTitle();
			},
		);

		store.subscribe(
			(state) => state.currentSessionId,
			(currentSessionId) => {
				if (this.config.enableSidebar && this.sidebarComponent) {
					this.sidebarComponent.setActiveSession(currentSessionId);
				}
				this.syncRouterToState();
				this.updateHeaderTitle();
			},
		);

		store.subscribe(
			(state) =>
				(state.isLoadingSession ? 1 : 0) | (state.error !== null ? 2 : 0) | (state.messages.length > 0 ? 4 : 0),
			() => this.syncRouterToState(),
		);

		let prevIsGenerating = false;

		// Feed subscribes to the hot lane because stream chunks are applied via
		// in-place mutation and should not run every normal selector per token.
		store.subscribeHot((state) => {
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

		store.subscribe(
			(state) => state.currentSessionId,
			() => {
				this.inputComponent.setText("");
				this.inputComponent.focus();
			},
		);

		store.subscribe(
			(state) => (state.generatingMessageId ? 2 : 0) | (state.isLoadingSession ? 1 : 0),
			(bits) => {
				const isGenerating = !!(bits & 2);
				const isLoadingSession = !!(bits & 1);

				this.inputComponent.setGeneratingState(isGenerating, isLoadingSession);
			},
		);
	}

	private updateHeaderTitle() {
		const state = this.engine.store.get();
		const activeSession = state.sessions.find((s) => s.id === state.currentSessionId);
		this.elements.headerTitle.textContent = activeSession ? activeSession.title : "New Chat";
	}

	private syncRouterToState() {
		const state = this.engine.store.get();
		const shouldHaveUrlId = state.messages.length > 0 || state.isLoadingSession;
		const targetId = shouldHaveUrlId ? state.currentSessionId : null;

		if (this.router.getId() === targetId) return;

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
		} else {
			if (isNavigation) return;

			this.elements.sidebarEl.classList.add("mur-hidden-desktop");
			this.container.classList.add("mur-sidebar-closed");
			lsSetItem("mur_sidebar_closed", "true");
		}
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
