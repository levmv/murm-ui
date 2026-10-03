import { el, queryOrThrow } from "../utils/dom";
import {
	ICON_EDIT,
	ICON_LINK,
	ICON_MORE_VERTICAL,
	ICON_PIN,
	ICON_PIN_OFF,
	ICON_SIDEBAR,
	ICON_TRASH,
} from "../utils/icons";
import { closeDropdown, type DropdownItem, showDropdown, updateDropdown } from "./dropdown";

export interface SidebarSession {
	id: string;
	title: string;
	isPinned?: boolean;
}

export type SidebarMenuItem = DropdownItem;

export interface SidebarLink {
	label: string;
	href?: string;
	/** Trusted SVG/HTML supplied by the application. */
	iconHtml?: string;
	onClick?: () => void | Promise<void>;
}

export interface SidebarLabels {
	newChat: string;
	close: string;
	loading: string;
	empty: string;
	loadMore: string;
	rename: string;
	pin: string;
	unpin: string;
	delete: string;
	pinned: string;
	options: (title: string) => string;
	renameChat: (title: string) => string;
	confirmDelete: (title: string) => string;
}

const defaultLabels: SidebarLabels = {
	newChat: "New chat",
	close: "Close sidebar",
	loading: "Loading chats...",
	empty: "No past chats.",
	loadMore: "Load more",
	rename: "Rename",
	pin: "Pin",
	unpin: "Unpin",
	delete: "Delete",
	pinned: "Pinned chat",
	options: (title) => `Options for chat "${title}"`,
	renameChat: (title) => `Rename chat "${title}"`,
	confirmDelete: (title) => `Delete chat "${title}"? This cannot be undone.`,
};

export interface SidebarConfig<T extends SidebarSession = SidebarSession> {
	/** App shell into which the sidebar is prepended. */
	container: HTMLElement | string;
	/** Adopt existing .mur-sidebar and .mur-sidebar-content instead. */
	reuseMarkup?: boolean;
	/** Brand name or application-owned logo/content. */
	header?: string | HTMLElement;
	links?: readonly SidebarLink[];
	footer?: HTMLElement;
	labels?: Partial<SidebarLabels>;
	collapsed?: boolean;
	onCollapse?: (collapsed: boolean) => void;
	onSelect?: (id: string) => void | Promise<void>;
	onNew?: () => void | Promise<void>;
	onRename?: (id: string, title: string) => void | Promise<void>;
	onPin?: (id: string, pinned: boolean) => void | Promise<void>;
	onDelete?: (id: string) => void | Promise<void>;
	onLoadMore?: () => void | Promise<void>;
	getHref?: (id: string) => string;
	/** No limit by default; the application enforces its own policy. */
	pinLimit?: number;
	menu?: (defaults: readonly SidebarMenuItem[], session: T) => readonly SidebarMenuItem[];
	confirmDelete?: (session: T) => boolean | Promise<boolean>;
	/** Overrides the inline error display. */
	onError?: (error: unknown) => void;
}

export interface SidebarState<T extends SidebarSession = SidebarSession> {
	/** Display order is owned by the caller. Put pinned sessions first for a divider. */
	sessions: readonly T[];
	activeId?: string | null;
	hasMore?: boolean;
	loading?: boolean;
}

interface Row<T extends SidebarSession> {
	session: T;
	el: HTMLElement;
	link: HTMLAnchorElement;
	title: HTMLElement;
	pin?: HTMLElement;
	options?: HTMLButtonElement;
	edit?: { input: HTMLInputElement; originalTitle: string };
	pending?: { title?: string; originalTitle: string };
}

/** App sidebar with optional conversation history; data and actions belong to the caller. */
export class Sidebar<T extends SidebarSession = SidebarSession> {
	readonly element: HTMLElement;
	private readonly root: HTMLElement;
	private readonly content: HTMLElement;
	private readonly labels: SidebarLabels;
	private readonly rows = new Map<string, Row<T>>();
	private readonly cleanup: (() => void)[] = [];
	private readonly media: MediaQueryList;
	private readonly loadMore: HTMLButtonElement;
	private readonly status: HTMLElement;
	private readonly divider: HTMLElement;
	private errorEl?: HTMLElement;
	private observer?: IntersectionObserver;
	private observing = false;
	private hasMore = false;
	private loading = false;
	private loadingMore = false;
	private loadFailed = false;
	private activeId?: string | null;
	private pinnedCount = 0;
	private updating = false;
	private destroyed = false;

	constructor(private readonly config: SidebarConfig<T>) {
		const root =
			typeof config.container === "string" ? document.querySelector<HTMLElement>(config.container) : config.container;
		if (!root) throw new Error(`Sidebar container not found: ${config.container}`);
		this.root = root;
		this.labels = { ...defaultLabels, ...config.labels };
		this.media = root.ownerDocument.defaultView!.matchMedia("(max-width: 768px)");
		if (config.reuseMarkup) {
			this.element = queryOrThrow(root, ".mur-sidebar");
			this.content = queryOrThrow(this.element, ".mur-sidebar-content");
		} else {
			const close = el("button", "mur-close-sidebar-btn", {
				type: "button",
				title: this.labels.close,
				innerHTML: ICON_SIDEBAR,
			});
			close.setAttribute("aria-label", this.labels.close);
			const header = el("div", "mur-sidebar-header");
			if (config.header !== undefined) {
				const title = el("div", "mur-sidebar-logo");
				if (typeof config.header === "string") title.textContent = config.header;
				else title.appendChild(config.header);
				header.appendChild(title);
			}
			header.appendChild(close);
			this.content = el("div", "mur-sidebar-content");
			this.element = el("aside", "mur-sidebar", null, [header]);
			if (config.onNew || config.links?.length) {
				const nav = el("nav", "mur-sidebar-actions");
				const addLink = (item: SidebarLink, newChat = false) => {
					const link: HTMLElement = el(
						item.href ? "a" : "button",
						"mur-sidebar-nav-btn",
						{
							title: item.label,
							innerHTML: item.iconHtml ?? ICON_LINK,
						},
						[el("span", "", { textContent: item.label })],
					);
					if (item.href) link.setAttribute("href", item.href);
					else link.setAttribute("type", "button");
					if (newChat) link.classList.add("mur-new-chat-btn");
					else {
						const click = (event: MouseEvent) => {
							if (item.href && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0))
								return;
							if (item.onClick) {
								event.preventDefault();
								this.invoke(item.onClick);
							}
							this.closeMobile();
						};
						link.addEventListener("click", click);
						this.cleanup.push(() => link.removeEventListener("click", click));
					}
					nav.appendChild(link);
				};
				if (config.onNew) addLink({ label: this.labels.newChat, iconHtml: ICON_EDIT }, true);
				for (const link of config.links ?? []) addLink(link);
				this.element.appendChild(nav);
			}
			this.element.appendChild(this.content);
			if (config.footer) this.element.appendChild(el("div", "mur-sidebar-footer", null, [config.footer]));
			root.prepend(this.element);
		}
		this.status = el("p", "mur-sidebar-status");
		this.divider = el("div", "mur-sidebar-pin-divider");
		this.loadMore = el("button", "mur-sidebar-load-more-trigger", { type: "button" });
		const listen = (target: EventTarget, type: string, listener: EventListener) => {
			target.addEventListener(type, listener);
			this.cleanup.push(() => target.removeEventListener(type, listener));
		};
		const opener = root.querySelector(".mur-open-sidebar-btn");
		const closer = this.element.querySelector(".mur-close-sidebar-btn");
		const create = this.element.querySelector(".mur-new-chat-btn");
		if (opener) {
			const expanded = opener.getAttribute("aria-expanded");
			this.cleanup.push(() => {
				if (expanded === null) opener.removeAttribute("aria-expanded");
				else opener.setAttribute("aria-expanded", expanded);
			});
		}
		listen(this.media, "change", () => {
			if (!this.media.matches) this.element.classList.remove("mur-mobile-open");
			this.syncExpanded();
		});
		if (opener)
			listen(opener, "click", (event) => {
				event.stopPropagation();
				this.open();
			});
		if (closer)
			listen(closer, "click", (event) => {
				event.stopPropagation();
				this.close();
			});
		if (create && config.onNew)
			listen(create, "click", () => {
				this.invoke(config.onNew!);
				this.closeMobile();
			});
		listen(this.loadMore, "click", () => {
			void this.requestMore();
		});
		listen(this.element, "click", (event) => {
			const target = event.target as Element;
			if (
				!this.media.matches &&
				this.root.classList.contains("mur-sidebar-closed") &&
				!target.closest("button, a, input, textarea, select, [role='button']")
			)
				this.open();
		});
		listen(root.ownerDocument, "click", (event) => {
			if (!this.element.contains(event.target as Node)) this.closeMobile();
		});
		listen(this.element, "keydown", (event) => {
			if ((event as KeyboardEvent).key === "Escape" && !event.defaultPrevented && this.media.matches) {
				this.close();
				(opener as HTMLElement | null)?.focus();
			}
		});
		if (typeof IntersectionObserver !== "undefined")
			this.observer = new IntersectionObserver(
				(entries) => {
					if (!this.loadFailed && entries.some((entry) => entry.isIntersecting)) void this.requestMore();
				},
				{ root: this.content, rootMargin: "50px" },
			);
		if (config.collapsed !== undefined && !this.media.matches) {
			const animated = root.classList.contains("mur-sidebar-animated");
			if (animated) root.classList.remove("mur-sidebar-animated");
			root.classList.toggle("mur-sidebar-closed", config.collapsed);
			if (animated) {
				this.element.getBoundingClientRect();
				root.classList.add("mur-sidebar-animated");
			}
		}
		if (config.onSelect || config.getHref) this.update({ sessions: [] });
		this.syncExpanded();
	}

	update({ sessions, activeId, hasMore = false, loading = false }: SidebarState<T>): void {
		if (this.destroyed) return;
		const ids = new Set(sessions.map((session) => session.id));
		if (ids.size !== sessions.length || ids.has(""))
			throw new Error("Sidebar session IDs must be unique and non-empty");
		this.pinnedCount = sessions.filter((session) => session.isPinned).length;
		this.activeId = activeId;
		this.hasMore = hasMore;
		this.loading = loading;
		const focused = this.content.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
		this.updating = true;
		try {
			for (const [id, row] of this.rows) {
				if (ids.has(id)) continue;
				closeDropdown(false, row.el);
				row.el.remove();
				this.rows.delete(id);
			}
			const nodes: HTMLElement[] = [];
			let divided = false;
			for (const [index, session] of sessions.entries()) {
				let row = this.rows.get(session.id);
				if (!row) {
					row = this.createRow(session);
					this.rows.set(session.id, row);
				}
				row.session = session;
				this.updateRow(row);
				nodes.push(row.el);
				if (session.isPinned && sessions[index + 1] && !sessions[index + 1].isPinned && !divided) {
					nodes.push(this.divider);
					divided = true;
				}
			}
			if (!sessions.length) {
				const text = loading ? this.labels.loading : this.labels.empty;
				if (this.status.textContent !== text) this.status.textContent = text;
				nodes.push(this.status);
			}
			if (hasMore && this.config.onLoadMore) nodes.push(this.loadMore);
			const wanted = new Set(nodes);
			for (const child of Array.from(this.content.children)) if (!wanted.has(child as HTMLElement)) child.remove();
			nodes.forEach((node, index) => {
				if (this.content.children[index] !== node) this.content.insertBefore(node, this.content.children[index]);
			});
			if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
		} finally {
			this.updating = false;
		}
		// The trigger may have moved; keep an open menu anchored to its row.
		for (const row of this.rows.values())
			if (row.options?.getAttribute("aria-expanded") === "true") updateDropdown(row.options, this.menuItems(row));
		this.syncLoadMore();
	}

	setActive(id: string | null): void {
		if (this.destroyed || this.activeId === id) return;
		const previous = this.activeId && this.rows.get(this.activeId);
		this.activeId = id;
		if (previous) this.updateRow(previous);
		const next = id && this.rows.get(id);
		if (next && next !== previous) this.updateRow(next);
	}

	open(): void {
		if (this.destroyed) return;
		if (this.media.matches) this.element.classList.add("mur-mobile-open");
		else this.setCollapsed(false);
		this.syncExpanded();
	}

	close(): void {
		if (this.destroyed) return;
		closeDropdown(false, this.element);
		if (this.media.matches) this.element.classList.remove("mur-mobile-open");
		else this.setCollapsed(true);
		this.syncExpanded();
		if (this.element.contains(document.activeElement))
			this.root.querySelector<HTMLElement>(".mur-open-sidebar-btn")?.focus({ preventScroll: true });
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		closeDropdown(false, this.element);
		this.observer?.disconnect();
		for (const cleanup of this.cleanup) cleanup();
		this.cleanup.length = 0;
		this.rows.clear();
		this.errorEl?.remove();
		if (this.config.reuseMarkup) this.content.replaceChildren();
		else this.element.remove();
	}

	private setCollapsed(collapsed: boolean): void {
		if (this.root.classList.contains("mur-sidebar-closed") === collapsed) return;
		this.root.classList.toggle("mur-sidebar-closed", collapsed);
		this.config.onCollapse?.(collapsed);
	}

	private syncExpanded(): void {
		const opener = this.root.querySelector(".mur-open-sidebar-btn");
		const expanded = String(
			this.media.matches
				? this.element.classList.contains("mur-mobile-open")
				: !this.root.classList.contains("mur-sidebar-closed"),
		);
		if (opener && opener.getAttribute("aria-expanded") !== expanded) opener.setAttribute("aria-expanded", expanded);
	}

	private closeMobile(): void {
		if (this.media.matches) this.close();
	}

	private createRow(session: T): Row<T> {
		const title = el("span", "mur-sidebar-item-title");
		const link = el("a", "mur-sidebar-item-link", null, [title]);
		const item = el("div", "mur-sidebar-item", null, [link]);
		item.dataset.sessionId = session.id;
		const row: Row<T> = { session, el: item, link, title };
		link.addEventListener("click", (event) => {
			if (
				this.config.getHref &&
				(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
			)
				return;
			if (this.destroyed) return;
			if (this.config.onSelect) {
				event.preventDefault();
				this.invoke(() => this.config.onSelect!(row.session.id));
			}
			this.closeMobile();
		});
		return row;
	}

	private updateRow(row: Row<T>): void {
		const { session, link } = row;
		const title =
			row.pending?.title !== undefined && session.title === row.pending.originalTitle
				? row.pending.title
				: session.title;
		if (row.title.textContent !== title) row.title.textContent = title;
		if (link.title !== title) link.title = title;
		const href = this.config.getHref?.(session.id) ?? "#";
		if (link.getAttribute("href") !== href) link.setAttribute("href", href);
		const active = session.id === this.activeId;
		row.el.classList.toggle("mur-active", active);
		row.el.classList.toggle("mur-pinned", Boolean(session.isPinned));
		if (active && !link.hasAttribute("aria-current")) link.setAttribute("aria-current", "page");
		else if (!active && link.hasAttribute("aria-current")) link.removeAttribute("aria-current");
		if (session.isPinned && !row.pin) {
			row.pin = el("span", "mur-sidebar-pin-icon", { innerHTML: ICON_PIN });
			row.pin.setAttribute("aria-label", this.labels.pinned);
			link.prepend(row.pin);
		} else if (!session.isPinned && row.pin) {
			row.pin.remove();
			row.pin = undefined;
		}
		const items = this.menuItems(row);
		if (items.length) {
			if (!row.options) {
				row.options = el("button", "mur-sidebar-options-btn", { type: "button", innerHTML: ICON_MORE_VERTICAL });
				row.options.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					if (!this.destroyed) {
						const items = this.menuItems(row);
						if (items.length) showDropdown(row.options!, items);
					}
				});
				row.el.appendChild(row.options);
			}
			const label = this.labels.options(title);
			if (row.options.title !== label) {
				row.options.title = label;
				row.options.setAttribute("aria-label", label);
			}
		} else if (row.options) {
			closeDropdown(false, row.el);
			row.options.remove();
			row.options = undefined;
		}
	}

	private menuItems(row: Row<T>): readonly SidebarMenuItem[] {
		const session = row.session;
		const defaults: SidebarMenuItem[] = [];
		if (this.config.onRename)
			defaults.push({
				id: "rename",
				label: this.labels.rename,
				iconHtml: ICON_EDIT,
				disabled: Boolean(row.pending),
				onClick: () => this.startRename(row),
			});
		if (this.config.onPin)
			defaults.push({
				id: session.isPinned ? "unpin" : "pin",
				label: session.isPinned ? this.labels.unpin : this.labels.pin,
				iconHtml: session.isPinned ? ICON_PIN_OFF : ICON_PIN,
				disabled: Boolean(row.pending) || (!session.isPinned && this.pinnedCount >= (this.config.pinLimit ?? Infinity)),
				onClick: () => {
					void this.perform(row, () => this.config.onPin!(session.id, !session.isPinned));
				},
			});
		if (this.config.onDelete)
			defaults.push({
				id: "delete",
				label: this.labels.delete,
				iconHtml: ICON_TRASH,
				danger: true,
				disabled: Boolean(row.pending),
				onClick: () => {
					void this.perform(row, async () => {
						const answer =
							this.config.confirmDelete?.(row.session) ?? confirm(this.labels.confirmDelete(row.session.title));
						const accepted = typeof answer === "boolean" ? answer : await answer;
						if (accepted && !this.destroyed && this.rows.get(session.id) === row)
							await this.config.onDelete!(session.id);
					});
				},
			});
		return this.config.menu?.(defaults, session) ?? defaults;
	}

	private startRename(row: Row<T>): void {
		if (row.edit || row.pending || this.destroyed) return;
		const input = el("input", "mur-sidebar-rename-input", {
			type: "text",
			value: row.session.title,
			ariaLabel: this.labels.renameChat(row.session.title),
		});
		const edit = { input, originalTitle: row.session.title };
		row.edit = edit;
		row.el.classList.add("mur-renaming");
		row.link.hidden = true;
		row.el.prepend(input);
		const finish = (save: boolean) => {
			if (this.updating || this.destroyed || row.edit !== edit || this.rows.get(row.session.id) !== row) return;
			row.edit = undefined;
			const title = input.value.trim();
			input.remove();
			row.link.hidden = false;
			row.el.classList.remove("mur-renaming");
			if (save && title && title !== edit.originalTitle)
				void this.perform(row, () => this.config.onRename!(row.session.id, title), title);
		};
		input.addEventListener("click", (event) => event.stopPropagation());
		input.addEventListener("blur", () => finish(true));
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.isComposing) {
				event.preventDefault();
				finish(true);
			} else if (event.key === "Escape") {
				event.preventDefault();
				finish(false);
				row.link.focus({ preventScroll: true });
			}
		});
		input.focus();
		input.select();
	}

	private async perform(row: Row<T>, action: () => void | Promise<void>, title?: string): Promise<void> {
		if (row.pending || this.destroyed || this.rows.get(row.session.id) !== row) return;
		const pending = { title, originalTitle: row.session.title };
		row.pending = pending;
		this.updateRow(row);
		try {
			this.errorEl?.remove();
			const result = action();
			if (result) await result;
			if (title !== undefined && row.session.title === pending.originalTitle) row.session = { ...row.session, title };
		} catch (error) {
			if (!this.destroyed && this.rows.get(row.session.id) === row) this.showError(error);
		} finally {
			if (!this.destroyed && this.rows.get(row.session.id) === row) {
				row.pending = undefined;
				this.updateRow(row);
				if (row.options) updateDropdown(row.options, this.menuItems(row));
			}
		}
	}

	private invoke(action: () => void | Promise<void>): void {
		if (this.destroyed) return;
		this.errorEl?.remove();
		try {
			const result = action();
			if (result) void result.catch((error) => this.showError(error));
		} catch (error) {
			this.showError(error);
		}
	}

	private showError(error: unknown): void {
		if (this.destroyed) return;
		if (this.config.onError) {
			this.config.onError(error);
			return;
		}
		this.errorEl ??= el("p", "mur-sidebar-status mur-sidebar-error", { role: "alert" });
		this.errorEl.textContent = error instanceof Error ? error.message : String(error);
		if (!this.errorEl.isConnected) this.content.after(this.errorEl);
	}

	private async requestMore(): Promise<void> {
		if (this.destroyed || this.loading || this.loadingMore || !this.hasMore || !this.config.onLoadMore) return;
		this.loadingMore = true;
		this.loadFailed = false;
		this.errorEl?.remove();
		this.syncLoadMore();
		try {
			await this.config.onLoadMore();
		} catch (error) {
			this.loadFailed = true;
			this.showError(error);
		} finally {
			this.loadingMore = false;
			if (!this.destroyed) this.syncLoadMore();
		}
	}

	private syncLoadMore(): void {
		const busy = this.loading || this.loadingMore;
		if (this.loadMore.disabled !== busy) this.loadMore.disabled = busy;
		const label = busy ? this.labels.loading : this.labels.loadMore;
		if (this.loadMore.textContent !== label) this.loadMore.textContent = label;
		const observe = this.hasMore && !busy && !this.loadFailed && Boolean(this.config.onLoadMore);
		if (observe === this.observing) return;
		this.observing = observe;
		if (observe) this.observer?.observe(this.loadMore);
		else this.observer?.unobserve(this.loadMore);
	}
}
