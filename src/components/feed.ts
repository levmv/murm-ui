import type { Message, RenderConfig } from "../core/types";
import { defaultLabels } from "../labels";
import { el, queryOrThrow } from "../utils/dom";
import { ICON_CHECK, ICON_COPY } from "../utils/icons";
import { buildFeedItems, type FeedItem, feedItemType, isAgentRunItem } from "./feed-items";
import { createFeedNode, type FeedNode } from "./feed-node";

const STICKY_THRESHOLD = 50;
// Distance from the top (px) at which scrolling up triggers an older-messages load.
const OLDER_LOAD_THRESHOLD = 200;
const MOBILE_SCROLL_QUERY = "(max-width: 768px)";

export interface FeedChanges {
	streamingMessageIds?: ReadonlySet<string>;
	/** Omit for structural updates that need regrouping. */
	dirtyMessageIds?: ReadonlySet<string>;
	loading?: boolean;
}

export class Feed {
	private scrollArea: HTMLElement;
	private historyContainer: HTMLElement;
	private spinnerEl: HTMLElement;
	private olderSpinnerEl: HTMLElement;

	private hasMoreOlder = false;
	private isLoadingOlder = false;
	// Detect prepends by message ID; grouped feed items can change when older history arrives.
	private firstMessageId: string | null = null;

	private nodes = new Map<string, FeedNode>();
	private itemsByMessageId = new Map<string, FeedItem>();
	private messagesById = new Map<string, Message>();
	private expandedSegments = new Set<string>();
	private lastMessages: Message[] | null = null;
	private isStickyToBottom = true;
	private isHistoryBusy = false;
	private lastScrollTop = 0;
	private isDestroyed = false;
	private readonly onToggleWorkSegment = (segmentId: string) => this.toggleWorkSegment(segmentId);
	private lastUpdate?: { messages: Message[]; changes: FeedChanges };
	private pendingScrollFrame: number | null = null;
	private pendingScrollBehavior: ScrollBehavior | null = null;
	private resizeObserver?: ResizeObserver;
	private mediaQueryList: MediaQueryList;
	private usesWindowScroll = false;
	private activeScrollTarget: "scrollArea" | "window" | null = null;
	private readonly fullscreen: boolean;

	private config: RenderConfig;

	constructor(container: HTMLElement, config: Omit<RenderConfig, "renderers">) {
		// Resolve display extensions once, outside message and streaming updates.
		this.config = {
			...config,
			renderers: config.plugins.flatMap((plugin) => plugin.renderers ?? []),
		};
		this.scrollArea = queryOrThrow<HTMLElement>(container, ".mur-chat-scroll-area");
		this.historyContainer = queryOrThrow<HTMLElement>(container, ".mur-chat-history");
		this.mediaQueryList = window.matchMedia(MOBILE_SCROLL_QUERY);
		this.fullscreen = config.fullscreen !== false;
		this.usesWindowScroll = this.fullscreen && this.mediaQueryList.matches;

		this.historyContainer.addEventListener("click", this.onHistoryClick);
		this.syncScrollListener();
		this.mediaQueryList.addEventListener("change", this.onMediaChange);

		if (typeof ResizeObserver !== "undefined") {
			this.resizeObserver = new ResizeObserver(() => {
				// Follow Markdown/image growth before paint to avoid a frame at the old scroll position.
				this.flushBottomScroll();
			});
			this.resizeObserver.observe(this.historyContainer);
			this.resizeObserver.observe(this.scrollArea);
		}

		this.spinnerEl = el("div", "mur-feed-spinner", {
			innerHTML: `<div class="mur-message-loading"><span class="mur-loading-dot"></span><span class="mur-loading-dot"></span><span class="mur-loading-dot"></span></div>`,
		});
		this.spinnerEl.hidden = true;
		this.scrollArea.appendChild(this.spinnerEl);

		this.olderSpinnerEl = el("div", "mur-feed-spinner mur-feed-spinner-top", {
			innerHTML: `<div class="mur-feed-older-status" role="status"><span class="mur-message-loading" aria-hidden="true"><span class="mur-loading-dot"></span><span class="mur-loading-dot"></span><span class="mur-loading-dot"></span></span><span></span></div>`,
		});
		this.olderSpinnerEl.querySelector(".mur-feed-older-status > span:last-child")!.textContent = (
			config.labels ?? defaultLabels
		).loadingOlder;
		this.olderSpinnerEl.hidden = true;
		this.historyContainer.parentElement?.insertBefore(this.olderSpinnerEl, this.historyContainer);
	}

	/** Updates the history-loading indicator while preserving the reader's scroll position. */
	public setOlderMessagesState(hasMore: boolean, isLoading: boolean): void {
		this.hasMoreOlder = hasMore;
		if (isLoading === this.isLoadingOlder) return;
		this.isLoadingOlder = isLoading;

		// Compensate for the spinner's height while the user reads older messages.
		const scrollTopBefore = this.getScrollMetrics().scrollTop;
		const before = this.olderSpinnerEl.offsetHeight;
		this.olderSpinnerEl.hidden = !isLoading;
		const delta = this.olderSpinnerEl.offsetHeight - before;
		if (delta !== 0 && !this.isStickyToBottom) this.adjustScrollTop(delta, scrollTopBefore);
	}

	public update(messages: Message[], changes: FeedChanges = {}) {
		if (this.lastUpdate?.changes.loading !== changes.loading) this.spinnerEl.hidden = !changes.loading;
		this.lastUpdate = { messages, changes };
		this.syncHistoryBusy(Boolean(changes.streamingMessageIds?.size));

		if (changes.loading) {
			this.isStickyToBottom = true;
			this.lastScrollTop = 0;
			this.clearAllNodes();
			this.lastMessages = null;
			this.firstMessageId = null;
			return;
		}

		const context = {
			messages,
			messagesById: this.messagesById,
			streamingMessageIds: changes.streamingMessageIds,
			onToggleWorkSegment: this.onToggleWorkSegment,
		};
		// Addressed updates visit only affected items; structural updates regroup.
		if (changes.dirtyMessageIds && this.lastMessages === messages) {
			const updated = new Set<string>();
			const dirtyContext = { ...context, dirtyMessageIds: changes.dirtyMessageIds };
			for (const id of changes.dirtyMessageIds) {
				const item = this.itemsByMessageId.get(id);
				if (!item || updated.has(item.id)) continue;
				updated.add(item.id);
				this.nodes.get(item.id)?.update(item, dirtyContext);
			}
			this.requestBottomScroll("auto");
			return;
		}
		const items = buildFeedItems(messages, {
			streamingMessageIds: changes.streamingMessageIds,
			showReasoning: this.config.showReasoning,
			isExpanded: (segmentId) => this.expandedSegments.has(segmentId),
			minAgentRunSteps: this.config.minAgentRunSteps,
			agentRunCollapse: this.config.agentRunCollapse,
		});

		// Preserve prepended history by height delta: regrouping a partial run can
		// replace the DOM node that would otherwise serve as the scroll anchor.
		const previousFirstMessageId = this.firstMessageId;
		const nextFirstMessageId = messages[0]?.id ?? null;
		const preservesPrependScroll =
			!this.isStickyToBottom &&
			previousFirstMessageId !== null &&
			nextFirstMessageId !== null &&
			nextFirstMessageId !== previousFirstMessageId &&
			messages.some((message, index) => index > 0 && message.id === previousFirstMessageId);
		const scrollBefore = preservesPrependScroll ? this.getScrollMetrics() : null;

		let structureChanged = this.lastMessages !== messages || this.nodes.size > items.length;
		this.lastMessages = messages;
		this.itemsByMessageId.clear();
		this.messagesById.clear();
		for (const message of messages) this.messagesById.set(message.id, message);

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (isAgentRunItem(item)) {
				this.itemsByMessageId.set(item.userMessage.id, item);
				for (const segment of item.segments)
					for (const message of segment.messages) this.itemsByMessageId.set(message.id, item);
			} else {
				this.itemsByMessageId.set(item.id, item);
			}

			let node = this.nodes.get(item.id);
			if (!node || node.type !== feedItemType(item)) {
				node?.destroy();
				node = createFeedNode(item, this.config);
				this.nodes.set(item.id, node);
				structureChanged = true;
			}

			if (structureChanged && this.historyContainer.children[i] !== node.el) {
				this.historyContainer.insertBefore(node.el, this.historyContainer.children[i]);
			}

			node.update(item, context);
		}

		if (structureChanged) {
			const currentIds = new Set<string>();
			for (const item of items) {
				currentIds.add(item.id);
			}
			for (const [id, node] of this.nodes.entries()) {
				if (!currentIds.has(id)) {
					node.destroy();
					this.nodes.delete(id);
				}
			}
		}

		if (scrollBefore) {
			const delta = this.getScrollMetrics().scrollHeight - scrollBefore.scrollHeight;
			if (delta !== 0) this.adjustScrollTop(delta, scrollBefore.scrollTop);
		}
		this.firstMessageId = nextFirstMessageId;

		this.requestBottomScroll(changes.streamingMessageIds?.size ? "auto" : "smooth");
	}

	private toggleWorkSegment(segmentId: string): void {
		if (this.expandedSegments.has(segmentId)) {
			this.expandedSegments.delete(segmentId);
		} else {
			this.expandedSegments.add(segmentId);
		}

		const request = this.lastUpdate;
		if (!request || this.isDestroyed) return;
		this.update(request.messages, { ...request.changes, dirtyMessageIds: undefined });
	}

	private syncHistoryBusy(isBusy: boolean): void {
		if (this.isHistoryBusy === isBusy) return;

		this.isHistoryBusy = isBusy;
		this.historyContainer.setAttribute("aria-busy", isBusy ? "true" : "false");
	}

	public destroy() {
		if (this.isDestroyed) return;
		this.isDestroyed = true;

		if (this.pendingScrollFrame !== null) {
			cancelAnimationFrame(this.pendingScrollFrame);
			this.pendingScrollFrame = null;
		}
		this.pendingScrollBehavior = null;

		this.resizeObserver?.disconnect();
		this.historyContainer.removeEventListener("click", this.onHistoryClick);
		this.removeActiveScrollListener();
		this.mediaQueryList.removeEventListener("change", this.onMediaChange);
		this.reset();
		this.spinnerEl.remove();
		this.olderSpinnerEl.remove();
	}

	public reset(): void {
		this.clearAllNodes();
		this.expandedSegments.clear();
		this.lastMessages = null;
		this.firstMessageId = null;
		this.lastUpdate = undefined;
		this.isStickyToBottom = true;
		this.lastScrollTop = 0;
	}

	public scrollToLatest(): void {
		this.requestBottomScroll("smooth", true);
	}

	private clearAllNodes(): void {
		for (const node of this.nodes.values()) {
			node.destroy();
		}
		this.nodes.clear();
		this.itemsByMessageId.clear();
		this.messagesById.clear();
		this.historyContainer.innerHTML = "";
	}

	private requestBottomScroll(behavior: ScrollBehavior, force = false) {
		if (this.isDestroyed) return;

		if (force) {
			this.isStickyToBottom = true;
		} else if (!this.isStickyToBottom) {
			return;
		}

		if (this.pendingScrollBehavior !== "smooth") {
			this.pendingScrollBehavior = behavior;
		}
		this.ensureBottomScrollFrame();
	}

	private ensureBottomScrollFrame() {
		if (this.pendingScrollFrame !== null) return;

		this.pendingScrollFrame = requestAnimationFrame(() => {
			this.pendingScrollFrame = null;
			this.flushBottomScroll();
		});
	}

	private flushBottomScroll(): void {
		if (this.pendingScrollFrame !== null) cancelAnimationFrame(this.pendingScrollFrame);
		this.pendingScrollFrame = null;
		const behavior = this.pendingScrollBehavior ?? "auto";
		this.pendingScrollBehavior = null;
		if (this.isDestroyed || !this.isStickyToBottom) return;
		if (this.usesWindowScroll) {
			window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
		} else {
			this.scrollArea.scrollTo({ top: this.scrollArea.scrollHeight, behavior });
		}
	}

	private onScroll = () => {
		const { scrollTop, scrollHeight, clientHeight } = this.getScrollMetrics();
		const distanceToBottom = scrollHeight - scrollTop - clientHeight;

		const delta = scrollTop - this.lastScrollTop;
		this.lastScrollTop = scrollTop;
		const isScrollingUp = delta < 0;

		if (isScrollingUp && distanceToBottom > STICKY_THRESHOLD) {
			this.isStickyToBottom = false;
		} else if (distanceToBottom <= STICKY_THRESHOLD) {
			this.isStickyToBottom = true;
		}

		// A shrinking composer can lower scrollTop at the bottom. Only request
		// older history when the reader is away from the bottom.
		if (
			isScrollingUp &&
			distanceToBottom > 1 &&
			scrollTop <= OLDER_LOAD_THRESHOLD &&
			this.hasMoreOlder &&
			!this.isLoadingOlder
		) {
			this.config.onReachTop?.();
		}
	};

	private onHistoryClick = (event: MouseEvent) => {
		const target = event.target as Element | null;
		const button = target?.closest?.(".mur-code-copy-btn") as HTMLElement | null;
		if (
			!button ||
			button.tagName !== "BUTTON" ||
			!this.historyContainer.contains(button) ||
			!button.closest(".mur-code-header")
		) {
			return;
		}

		void this.copyCode(button as HTMLButtonElement);
	};

	private async copyCode(button: HTMLButtonElement): Promise<void> {
		const codeBlock = button.closest(".mur-code-block");
		const codeEl = codeBlock?.querySelector("pre > code");
		const text = codeEl?.textContent;
		if (text === undefined || typeof navigator === "undefined" || !navigator.clipboard) return;

		try {
			await navigator.clipboard.writeText(text);
			button.innerHTML = ICON_CHECK;
			window.setTimeout(() => {
				if (button.isConnected) {
					button.innerHTML = ICON_COPY;
				}
			}, 2000);
		} catch {
			// Copy is best-effort; leave the button unchanged on failure.
		}
	}

	private getScrollMetrics(): { scrollTop: number; scrollHeight: number; clientHeight: number } {
		if (this.usesWindowScroll) {
			const doc = document.documentElement;

			return {
				scrollTop: window.scrollY || doc.scrollTop,
				scrollHeight: doc.scrollHeight,
				clientHeight: window.innerHeight,
			};
		}

		return {
			scrollTop: this.scrollArea.scrollTop,
			scrollHeight: this.scrollArea.scrollHeight,
			clientHeight: this.scrollArea.clientHeight,
		};
	}

	private adjustScrollTop(delta: number, before: number): void {
		// Layout reads may already have applied the browser's native anchoring.
		// Set the intended absolute position, rather than compensating twice.
		const target = before + delta;
		if (this.usesWindowScroll) {
			window.scrollBy(0, target - this.getScrollMetrics().scrollTop);
		} else {
			this.scrollArea.scrollTop = target;
		}
		// Keep lastScrollTop in sync so this programmatic shift is not read as a
		// user scroll-up that would spuriously re-trigger a load.
		this.lastScrollTop = this.getScrollMetrics().scrollTop;
	}

	private onMediaChange = (event: MediaQueryListEvent) => {
		this.usesWindowScroll = this.fullscreen && event.matches;
		this.syncScrollListener();
		this.lastScrollTop = this.getScrollMetrics().scrollTop;
	};

	private syncScrollListener(): void {
		const nextTarget = this.usesWindowScroll ? "window" : "scrollArea";
		if (this.activeScrollTarget === nextTarget) return;

		this.removeActiveScrollListener();
		if (nextTarget === "window") {
			window.addEventListener("scroll", this.onScroll, { passive: true });
		} else {
			this.scrollArea.addEventListener("scroll", this.onScroll, { passive: true });
		}
		this.activeScrollTarget = nextTarget;
	}

	private removeActiveScrollListener(): void {
		if (this.activeScrollTarget === "window") {
			window.removeEventListener("scroll", this.onScroll);
		} else if (this.activeScrollTarget === "scrollArea") {
			this.scrollArea.removeEventListener("scroll", this.onScroll);
		}
		this.activeScrollTarget = null;
	}
}
