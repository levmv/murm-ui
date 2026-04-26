import type { ChatSessionMeta } from "../core/types";
import { el, queryOrThrow, replaceNodes } from "../utils/dom";

export interface SidebarProps {
	container: HTMLElement;
	onNewChat: () => void;
	onSelectSession: (id: string) => void;
	onDeleteSession: (id: string) => void;
	onLoadMore: () => void;
	onClose: () => void;
	getSessionHref: (id: string) => string;
}

export class Sidebar {
	private sidebar: HTMLElement;
	private content: HTMLElement;
	private newChatBtn?: HTMLButtonElement | null;
	private closeBtn?: HTMLButtonElement | null;

	private loadMoreTrigger: HTMLElement;
	private observer?: IntersectionObserver;

	private onNewChatBound = () => this.props.onNewChat();
	private onCloseBound = (e: MouseEvent) => {
		e.stopPropagation();
		this.props.onClose();
	};

	constructor(private props: SidebarProps) {
		this.sidebar = queryOrThrow<HTMLElement>(props.container, ".mur-sidebar");
		this.content = queryOrThrow<HTMLElement>(this.sidebar, ".mur-sidebar-content");
		this.newChatBtn = this.sidebar.querySelector(".mur-new-chat-btn");
		this.closeBtn = this.sidebar.querySelector(".mur-close-sidebar-btn");

		this.loadMoreTrigger = document.createElement("div");
		this.loadMoreTrigger.style.height = "1px";

		if (typeof IntersectionObserver !== "undefined") {
			this.observer = new IntersectionObserver(
				(entries) => {
					if (entries[0].isIntersecting) {
						this.props.onLoadMore();
					}
				},
				{
					root: this.content, // Watch scrolling inside the sidebar
					rootMargin: "50px", // Trigger 50px before it actually becomes visible
				},
			);
		}

		this.bindEvents();
	}

	private bindEvents() {
		if (this.newChatBtn) {
			this.newChatBtn.addEventListener("click", this.onNewChatBound);
		}
		if (this.closeBtn) {
			this.closeBtn.addEventListener("click", this.onCloseBound);
		}
	}

	public renderSessions(sessions: ChatSessionMeta[], activeId: string, hasMore: boolean, isLoading = false) {
		if (isLoading && sessions.length === 0) {
			this.content.innerHTML =
				'<p style="padding: 1rem; font-size: 0.9rem; color: #9ca3af; text-align: center;">Loading chats...</p>';
			this.observer?.unobserve(this.loadMoreTrigger);
			return;
		}

		if (sessions.length === 0) {
			this.content.innerHTML =
				'<p style="padding: 1rem; font-size: 0.9rem; color: #9ca3af; text-align: center;">No past chats.</p>';
			this.observer?.unobserve(this.loadMoreTrigger);
			return;
		}

		const fragment = document.createDocumentFragment();

		sessions.forEach((session) => {
			const isActive = session.id === activeId;
			fragment.appendChild(this.createSessionNode(session, isActive));
		});

		if (hasMore) {
			fragment.appendChild(this.loadMoreTrigger);
		}

		replaceNodes(this.content, fragment);

		if (hasMore) {
			this.observer?.observe(this.loadMoreTrigger);
		} else {
			this.observer?.unobserve(this.loadMoreTrigger);
		}
	}

	private createSessionNode(session: ChatSessionMeta, isActive: boolean): HTMLElement {
		const item = el("div", `mur-sidebar-item ${isActive ? "mur-active" : ""}`);
		item.setAttribute("data-session-id", session.id);

		const link = el("a", "mur-sidebar-item-link", {
			href: this.props.getSessionHref(session.id),
			textContent: session.title,
			title: session.title,
			onclick: (e) => {
				e.preventDefault();
				this.props.onSelectSession(session.id);
			},
		});

		if (isActive) {
			link.setAttribute("aria-current", "page");
		}

		const deleteBtn = el("button", "mur-delete-btn", {
			type: "button",
			innerHTML: "×",
			title: `Delete "${session.title}"`,
			onclick: (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.props.onDeleteSession(session.id);
			},
		});
		deleteBtn.setAttribute("aria-label", `Delete chat "${session.title}"`);
		item.append(link, deleteBtn);

		return item;
	}

	public setActiveSession(id: string) {
		const current = this.content.querySelector<HTMLElement>(".mur-sidebar-item.mur-active");
		if (current?.getAttribute("data-session-id") === id) {
			return;
		}

		if (current) {
			current.classList.remove("mur-active");
			current.querySelector(".mur-sidebar-item-link")?.removeAttribute("aria-current");
		}

		const next = Array.from(this.content.querySelectorAll<HTMLElement>(".mur-sidebar-item")).find(
			(item) => item.getAttribute("data-session-id") === id,
		);

		if (next) {
			next.classList.add("mur-active");
			next.querySelector(".mur-sidebar-item-link")?.setAttribute("aria-current", "page");
		}
	}

	public setVisible(isVisible: boolean) {
		this.sidebar.style.display = isVisible ? "" : "none";
	}

	public destroy() {
		this.observer?.disconnect();
		if (this.newChatBtn) {
			this.newChatBtn.removeEventListener("click", this.onNewChatBound);
		}
		if (this.closeBtn) {
			this.closeBtn.removeEventListener("click", this.onCloseBound);
		}
	}
}
