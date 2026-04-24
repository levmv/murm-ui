import { marked } from "marked";
import { extractPlainText } from "../core/msg-utils";
import type { ContentBlock, Message, RenderConfig } from "../core/types";
import { el, syncDOM } from "../utils/dom";
import { renderSafeHTML } from "../utils/html";
import { ICON_CHECK, ICON_COPY } from "../utils/icons";

const MARKDOWN_THROTTLE_MS = 70;

export class MessageNode {
	public readonly el: HTMLElement;

	private blocksContainer: HTMLElement;
	private loadingEl?: HTMLElement;
	private errorEl?: HTMLElement;
	private actionsEl?: HTMLElement;

	// Track state per-block
	private blockNodes = new Map<string, HTMLElement>();
	private blockTextCache = new Map<string, string>();
	private blockRenderSeqs = new Map<string, number>();
	private blockTimers = new Map<string, number>();

	private cacheError: string | null = null;
	private cacheIsGenerating: boolean = false;
	private isDestroyed = false;

	constructor(
		msg: Message,
		private config: RenderConfig,
	) {
		this.el = document.createElement("div");
		this.el.className = `message ${msg.role}`;
		if (msg.role === "assistant") {
			this.el.setAttribute("role", "article");
			this.el.setAttribute("aria-label", "AI response");
		}

		this.blocksContainer = el("div", "message-blocks-wrapper");
		this.el.appendChild(this.blocksContainer);
	}

	public update(msg: Message, isGenerating: boolean, error: string | null) {
		if (this.cacheIsGenerating !== isGenerating) {
			this.el.classList.toggle("generating", isGenerating);
			this.cacheIsGenerating = isGenerating;
		}

		this.renderBlocks(msg, isGenerating);
		this.renderLoading(msg, isGenerating, error);
		this.renderActions(msg);
		this.renderError(error);

		for (const plugin of this.config.plugins) {
			if (plugin.onMessageRender) {
				plugin.onMessageRender(msg, this.el, isGenerating);
			}
		}
	}

	public destroy() {
		this.isDestroyed = true;
		for (const timer of this.blockTimers.values()) {
			clearTimeout(timer);
		}
		this.el.remove();
	}

	private renderLoading(msg: Message, isGenerating: boolean, error: string | null) {
		const hasVisibleBlocks = this.blockNodes.size > 0;
		const isLoading = isGenerating && !error && msg.role === "assistant" && !hasVisibleBlocks;

		if (isLoading) {
			if (!this.loadingEl) {
				this.loadingEl = el("div", "message-loading", {
					innerHTML: `<span class="dot"></span><span class="dot"></span><span class="dot"></span>`,
				});
				this.el.appendChild(this.loadingEl);
			}
		} else if (this.loadingEl) {
			this.loadingEl.remove();
			this.loadingEl = undefined;
		}
	}

	private renderBlocks(msg: Message, isGenerating: boolean) {
		const currentBlockIds = new Set<string>();
		let displayIndex = 0;

		for (let i = 0; i < msg.blocks.length; i++) {
			const block = msg.blocks[i];
			const isLastBlock = i === msg.blocks.length - 1;

			let container = this.blockNodes.get(block.id);
			let isNew = false;

			if (!container) {
				container = el("div", `content-block block-${block.type}`);
				container.dataset.blockId = block.id;
				isNew = true;
			}

			let handledByPlugin = false;
			for (const plugin of this.config.plugins) {
				if (plugin.onBlockRender?.(block, container, isGenerating)) {
					handledByPlugin = true;
					break;
				}
			}

			if (!handledByPlugin) {
				if (block.type === "reasoning") {
					// Fallback behavior: If no plugin (like ThinkingPlugin) handles reasoning blocks,
					// we skip them entirely. No DOM node will be added or retained.
					continue;
				} else if (block.type === "text") {
					this.renderTextBlock(block, container, isGenerating, isLastBlock);
				} else if (block.type === "file") {
					this.renderFileBlock(block, container);
				} else if (block.type === "tool_call") {
					container.textContent = `🛠 Tool Call: ${block.name} (${block.status})`;
					container.className = `content-block block-tool tool-${block.status}`;
				}
			}

			// If we didn't 'continue', it means the block is visible
			currentBlockIds.add(block.id);

			if (isNew) {
				this.blocksContainer.appendChild(container);
				this.blockNodes.set(block.id, container);
			}

			// Ensure physical DOM order matches visual index order
			if (this.blocksContainer.children[displayIndex] !== container) {
				this.blocksContainer.insertBefore(container, this.blocksContainer.children[displayIndex]);
			}
			displayIndex++;
		}

		// Cleanup orphaned or newly-ignored blocks
		for (const [id, container] of this.blockNodes.entries()) {
			if (!currentBlockIds.has(id)) {
				container.remove();
				this.blockNodes.delete(id);
				this.blockTextCache.delete(id);
				this.blockRenderSeqs.delete(id);
				this.clearBlockTimer(id);
			}
		}
	}

	private nextBlockRenderSeq(blockId: string): number {
		const seq = (this.blockRenderSeqs.get(blockId) || 0) + 1;
		this.blockRenderSeqs.set(blockId, seq);
		return seq;
	}

	private renderTextBlock(
		block: Extract<ContentBlock, { type: "text" }>,
		container: HTMLElement,
		isGenerating: boolean,
		isActivelyTypingBlock: boolean,
	) {
		const cached = this.blockTextCache.get(block.id);
		if (cached === block.text) return;

		const isActivelyTyping = isGenerating && isActivelyTypingBlock;

		if (!isActivelyTyping) {
			this.clearBlockTimer(block.id);

			this.applyMarkdown(block.id, block.text, this.nextBlockRenderSeq(block.id), container);
			return;
		}

		if (this.blockTimers.has(block.id)) return;

		const timer = window.setTimeout(() => {
			this.blockTimers.delete(block.id);

			this.applyMarkdown(block.id, block.text, this.nextBlockRenderSeq(block.id), container);
		}, MARKDOWN_THROTTLE_MS);

		this.blockTimers.set(block.id, timer);
	}

	private renderFileBlock(block: Extract<ContentBlock, { type: "file" }>, container: HTMLElement) {
		if (container.hasChildNodes()) return; // Already rendered

		if (block.mimeType.startsWith("image/")) {
			container.appendChild(el("img", "attachment-image", { src: block.data }));
		} else {
			container.appendChild(el("div", "attachment-file-pill", { textContent: `📄 ${block.name || "File"}` }));
		}
	}

	private async applyMarkdown(blockId: string, content: string, seq: number, container: HTMLElement) {
		const html = await marked.parse(content);
		if (this.isDestroyed || seq !== this.blockRenderSeqs.get(blockId)) return;

		let contentEl = container.querySelector(".message-content");

		if (!contentEl) {
			contentEl = el("div", "message-content");
			renderSafeHTML(contentEl as HTMLElement, html, this.config.highlighter);
			container.appendChild(contentEl);
		} else {
			const tempDiv = el("div", "message-content");
			renderSafeHTML(tempDiv, html, this.config.highlighter);
			syncDOM(contentEl, tempDiv);
		}

		this.blockTextCache.set(blockId, content);
	}

	private renderError(error: string | null) {
		if (!error) {
			if (this.errorEl) this.errorEl.style.display = "none";
			this.cacheError = null;
			return;
		}

		if (!this.errorEl) {
			this.errorEl = el("div", "message-error");
			this.el.appendChild(this.errorEl);
		}

		if (this.cacheError !== error) {
			this.errorEl.textContent = `⚠ ${error}`;
			this.errorEl.style.display = "flex";
			this.cacheError = error;
		}
	}

	private renderActions(msg: Message) {
		if (msg.role !== "assistant" || msg.blocks.length === 0) {
			if (this.actionsEl) this.actionsEl.style.display = "none";
			return;
		}

		if (!this.actionsEl) {
			const actionButtons: HTMLElement[] = [];

			if (typeof navigator !== "undefined" && navigator.clipboard) {
				const copyBtn = el("button", "action-icon-btn", {
					title: "Copy message",
					innerHTML: ICON_COPY,
				});
				copyBtn.addEventListener("click", async () => {
					try {
						// Extract all text blocks combined
						const textToCopy = extractPlainText(msg);
						await navigator.clipboard.writeText(textToCopy);
						copyBtn.innerHTML = ICON_CHECK;
						setTimeout(() => (copyBtn.innerHTML = ICON_COPY), 2000);
					} catch {
						// Ignore
					}
				});
				actionButtons.push(copyBtn);
			}

			this.actionsEl = el("div", "message-actions", null, actionButtons);
			this.el.appendChild(this.actionsEl);
		}
	}

	private clearBlockTimer(blockId: string) {
		const timer = this.blockTimers.get(blockId);
		if (timer) {
			clearTimeout(timer);
			this.blockTimers.delete(blockId);
		}
	}
}
