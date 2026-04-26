import type { Message, RenderConfig } from "../core/types";
import { el, queryOrThrow } from "../utils/dom";
import { MessageNode } from "./message-node";

const STICKY_THRESHOLD = 50;

export class Feed {
	private scrollArea: HTMLElement;
	private historyContainer: HTMLElement;
	private spinnerEl: HTMLElement;

	private nodes = new Map<string, MessageNode>();
	private lastMessagesRef: Message[] | null = null;
	private isStickyToBottom = true;
	private lastScrollTop = 0;
	private isDestroyed = false;

	private pendingScrollFrame: number | null = null;
	private pendingScrollBehavior: ScrollBehavior | null = null;
	private resizeObserver?: ResizeObserver;

	constructor(
		container: HTMLElement,
		private config: RenderConfig,
	) {
		this.scrollArea = queryOrThrow<HTMLElement>(container, ".mur-chat-scroll-area");
		this.historyContainer = queryOrThrow<HTMLElement>(container, ".mur-chat-history");

		this.scrollArea.addEventListener("scroll", this.onScroll, { passive: true });

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
		this.spinnerEl.style.display = "none";
		this.scrollArea.appendChild(this.spinnerEl);
	}

	public update(
		messages: Message[],
		generatingMessageId: string | null,
		isLoadingSession: boolean,
		generationStarted: boolean,
		error: { message: string; id?: string } | null = null,
	) {
		this.spinnerEl.style.display = isLoadingSession ? "flex" : "none";

		if (isLoadingSession) {
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

	public destroy() {
		if (this.isDestroyed) return;
		this.isDestroyed = true;

		if (this.pendingScrollFrame !== null) {
			cancelAnimationFrame(this.pendingScrollFrame);
			this.pendingScrollFrame = null;
		}
		this.pendingScrollBehavior = null;

		this.resizeObserver?.disconnect();
		this.scrollArea.removeEventListener("scroll", this.onScroll);
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

			this.scrollArea.scrollTo({
				top: this.scrollArea.scrollHeight,
				behavior,
			});
		});
	}

	private onScroll = () => {
		const { scrollTop, scrollHeight, clientHeight } = this.scrollArea;
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
}
