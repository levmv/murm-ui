import type { Message, RenderConfig } from "../core/types";
import { el, queryOrThrow } from "../utils/dom";
import { ICON_CHECK, ICON_COPY } from "../utils/icons";
import { MessageNode } from "./message-node";

const STICKY_THRESHOLD = 50;
const MOBILE_SCROLL_QUERY = "(max-width: 768px)";

export class Feed {
	private scrollArea: HTMLElement;
	private historyContainer: HTMLElement;
	private spinnerEl: HTMLElement;

	private nodes = new Map<string, MessageNode>();
	private lastMessagesRef: Message[] | null = null;
	private isStickyToBottom = true;
	private isHistoryBusy = false;
	private lastScrollTop = 0;
	private isDestroyed = false;

	private pendingScrollFrame: number | null = null;
	private pendingScrollBehavior: ScrollBehavior | null = null;
	private resizeObserver?: ResizeObserver;
	private mediaQueryList: MediaQueryList;
	private isMobileScroll = false;
	private activeScrollTarget: "scrollArea" | "window" | null = null;

	constructor(
		container: HTMLElement,
		private config: RenderConfig,
	) {
		this.scrollArea = queryOrThrow<HTMLElement>(container, ".mur-chat-scroll-area");
		this.historyContainer = queryOrThrow<HTMLElement>(container, ".mur-chat-history");
		this.mediaQueryList = window.matchMedia(MOBILE_SCROLL_QUERY);
		this.isMobileScroll = this.mediaQueryList.matches;

		this.historyContainer.addEventListener("click", this.onHistoryClick);
		this.syncScrollListener();
		this.addMediaListener();

		if (typeof ResizeObserver !== "undefined") {
			this.resizeObserver = new ResizeObserver(() => {
				this.requestBottomScroll("auto");
			});
			this.resizeObserver.observe(this.historyContainer);
			this.resizeObserver.observe(this.scrollArea);
		}

		this.spinnerEl = el("div", "mur-feed-spinner", {
			innerHTML: `<div class="mur-message-loading"><span class="mur-loading-dot"></span><span class="mur-loading-dot"></span><span class="mur-loading-dot"></span></div>`,
		});
		this.spinnerEl.hidden = true;
		this.scrollArea.appendChild(this.spinnerEl);
	}

	public update(
		messages: Message[],
		generatingMessageId: string | null,
		isLoadingSession: boolean,
		generationStarted: boolean,
		error: { message: string; id?: string } | null = null,
	) {
		this.syncHistoryBusy(generatingMessageId !== null);
		this.spinnerEl.hidden = !isLoadingSession;

		if (isLoadingSession) {
			this.isStickyToBottom = true;
			this.lastScrollTop = 0;
			this.clearAllNodes();
			this.lastMessagesRef = null;
			return;
		}

		if (generationStarted) {
			this.isStickyToBottom = true;
		}

		// Skip heavy DOM syncs if the array reference hasn't changed (e.g. during streaming)
		const structureChanged = this.lastMessagesRef !== messages || this.nodes.size > messages.length;
		this.lastMessagesRef = messages;

		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];

			const isGenerating = msg.id === generatingMessageId;
			const isTargetOfError = error && error.id === msg.id;
			const targetError = isTargetOfError ? error.message : null;

			let node = this.nodes.get(msg.id);

			if (!node) {
				node = new MessageNode(msg, this.config);
				this.nodes.set(msg.id, node);
			}

			// Ensure physical DOM order matches array order
			if (structureChanged && this.historyContainer.children[i] !== node.el) {
				this.historyContainer.insertBefore(node.el, this.historyContainer.children[i]);
			}

			node.update(msg, isGenerating, targetError);
		}

		// Cleanup removed messages
		if (structureChanged) {
			const currentIds = new Set(messages.map((m) => m.id));
			for (const [id, node] of this.nodes.entries()) {
				if (!currentIds.has(id)) {
					node.destroy();
					this.nodes.delete(id);
				}
			}
		}

		const isActivelyStreaming = generatingMessageId !== null && !generationStarted;
		this.requestBottomScroll(isActivelyStreaming ? "auto" : "smooth");
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
		this.removeMediaListener();
		this.clearAllNodes();
		this.spinnerEl.remove();
	}

	private clearAllNodes(): void {
		for (const node of this.nodes.values()) {
			node.destroy();
		}
		this.nodes.clear();
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
			const behavior = this.pendingScrollBehavior ?? "auto";

			this.pendingScrollFrame = null;
			this.pendingScrollBehavior = null;

			if (this.isDestroyed || !this.isStickyToBottom) return;

			if (this.isMobileScroll) {
				window.scrollTo({
					top: document.documentElement.scrollHeight,
					behavior,
				});
			} else {
				this.scrollArea.scrollTo({
					top: this.scrollArea.scrollHeight,
					behavior,
				});
			}
		});
	}

	private onScroll = () => {
		const { scrollTop, scrollHeight, clientHeight } = this.getScrollMetrics();
		const distanceToBottom = scrollHeight - scrollTop - clientHeight;

		const delta = scrollTop - this.lastScrollTop;
		this.lastScrollTop = scrollTop;
		const isScrollingUp = delta < 0;

		// Break lock if user explicitly scrolls up
		if (isScrollingUp && distanceToBottom > STICKY_THRESHOLD) {
			this.isStickyToBottom = false;
		}
		// Re-engage lock if user hits the bottom
		else if (distanceToBottom <= STICKY_THRESHOLD) {
			this.isStickyToBottom = true;
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
		if (this.isMobileScroll) {
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

	private onMediaChange = (event: MediaQueryListEvent) => {
		this.isMobileScroll = event.matches;
		this.syncScrollListener();
		this.lastScrollTop = this.getScrollMetrics().scrollTop;
	};

	private syncScrollListener(): void {
		const nextTarget = this.isMobileScroll ? "window" : "scrollArea";
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

	private addMediaListener(): void {
		if (typeof this.mediaQueryList.addEventListener === "function") {
			this.mediaQueryList.addEventListener("change", this.onMediaChange);
		} else {
			this.mediaQueryList.addListener(this.onMediaChange);
		}
	}

	private removeMediaListener(): void {
		if (typeof this.mediaQueryList.removeEventListener === "function") {
			this.mediaQueryList.removeEventListener("change", this.onMediaChange);
		} else {
			this.mediaQueryList.removeListener(this.onMediaChange);
		}
	}
}
