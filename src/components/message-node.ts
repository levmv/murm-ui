import type {
	ActionButtonDef,
	BlockRenderer,
	BlockRendererInstance,
	ContentBlock,
	Message,
	RenderConfig,
	RendererContext,
} from "../core/types";
import { defaultLabels } from "../labels";
import { renderMarkdownContent } from "../markdown";
import { el, syncDOMChildren } from "../utils/dom";
import type { MessageStall } from "./message-stall";

const MARKDOWN_THROTTLE_MS = 70;

interface MarkdownState {
	latest: string;
	role: Message["role"];
	streaming: boolean;
	revision: number;
	rendered?: number;
	pending?: number;
	timer?: ReturnType<typeof setTimeout>;
	/** Allocated only by an explicit whenRendered request. */
	waiting?: Promise<void>;
	resolveWaiting?: () => void;
}

interface BlockState {
	container: HTMLElement;
	type: ContentBlock["type"];
	kind?: string;
	renderer?: BlockRendererInstance;
	definition?: BlockRenderer;
	markdown?: MarkdownState;
}

interface ActionState {
	button: HTMLButtonElement;
	definition: ActionButtonDef;
	iconHtml: string;
}

/** Shared by the mounted chunks of one streaming message. */
export interface MessageProgress {
	lastChunk: Message;
	hasVisibleBlocks: boolean;
}

export class MessageNode {
	public readonly el: HTMLElement;

	private blocksContainer: HTMLElement;
	private loadingEl?: HTMLElement;
	private errorEl?: HTMLElement;
	private actionsEl?: HTMLElement;

	private activeBlocks = new Map<string, BlockState>();
	private actionButtons = new Map<string, ActionState>();

	private lastError: string | null = null;
	private lastRole?: Message["role"];
	private lastIsGenerating = false;
	private lastCanAct = true;
	private lastHasActionContent = false;
	private currentMessage: Message | null = null;
	private stall?: MessageStall;
	private isDestroyed = false;

	constructor(
		msg: Message,
		private config: RenderConfig,
	) {
		this.el = document.createElement("div");
		this.el.className = `mur-message mur-message-${msg.role}`;
		this.lastRole = msg.role;
		if (msg.role === "assistant") {
			this.el.setAttribute("role", "article");
			this.el.setAttribute("aria-label", (this.config.labels ?? defaultLabels).assistant);
		}

		this.blocksContainer = el("div", "mur-message-blocks-wrapper");
		this.el.appendChild(this.blocksContainer);
	}

	public update(
		msg: Message,
		isGenerating: boolean,
		messages: readonly Message[],
		progress?: MessageProgress,
		stall?: MessageStall,
	) {
		if (this.isDestroyed) return;
		this.currentMessage = msg;
		this.stall = stall;
		if (this.lastRole !== msg.role) {
			this.el.classList.remove(`mur-message-${this.lastRole}`);
			this.el.classList.add(`mur-message-${msg.role}`);
			if (msg.role === "assistant") {
				this.el.setAttribute("role", "article");
				this.el.setAttribute("aria-label", (this.config.labels ?? defaultLabels).assistant);
			} else {
				this.el.removeAttribute("role");
				this.el.removeAttribute("aria-label");
			}
			this.lastRole = msg.role;
		}
		if (this.lastIsGenerating !== isGenerating) {
			this.el.classList.toggle("mur-generating", isGenerating);
			this.lastIsGenerating = isGenerating;
		}

		const hasVisibleBlocks =
			this.renderBlocks(msg, isGenerating, messages, stall) || progress?.hasVisibleBlocks === true;
		if (progress) progress.hasVisibleBlocks = hasVisibleBlocks;
		const showProgress = !progress || progress.lastChunk.blocks === msg.blocks;
		if (stall && showProgress)
			stall.render = (stalled) => this.renderLoading(msg, isGenerating, hasVisibleBlocks, stalled);
		else this.renderLoading(msg, isGenerating && showProgress, hasVisibleBlocks);
		this.renderActions(msg, isGenerating);
		this.renderError(msg.error ?? null);
	}

	public destroy() {
		this.isDestroyed = true;
		this.stall = undefined;
		for (const state of this.activeBlocks.values()) {
			this.destroyBlock(state);
		}
		this.activeBlocks.clear();
		this.actionButtons.clear();
		this.currentMessage = null;
		this.el.remove();
	}

	public collectPendingMarkdown(pending: Promise<void>[]): void {
		for (const state of this.activeBlocks.values()) {
			const markdown = state.markdown;
			if (!markdown || markdown.rendered === markdown.revision) continue;
			markdown.waiting ??= new Promise<void>((resolve) => {
				markdown.resolveWaiting = resolve;
			});
			pending.push(markdown.waiting);
			if (markdown.pending !== markdown.revision) void this.applyMarkdown(state, markdown);
		}
	}

	private renderLoading(msg: Message, isGenerating: boolean, hasVisibleBlocks: boolean, stalled = false) {
		const activity = msg.activity;
		const isLoading =
			isGenerating && !msg.error && msg.role === "assistant" && (activity || !hasVisibleBlocks || stalled);

		if (isLoading) {
			if (!this.loadingEl) {
				this.loadingEl = el("div", "mur-message-loading", {
					innerHTML: `<span class="mur-loading-dot" aria-hidden="true"></span><span class="mur-loading-dot" aria-hidden="true"></span><span class="mur-loading-dot" aria-hidden="true"></span><span class="mur-loading-label"></span>`,
				});
				this.loadingEl.setAttribute("role", "status");
				this.blocksContainer.after(this.loadingEl);
			}
			this.loadingEl.classList.toggle("mur-loading-activity", Boolean(activity));
			const label = this.loadingEl.lastElementChild!;
			const text = activity || (this.config.labels ?? defaultLabels).responding;
			if (label.textContent !== text) label.textContent = text;
		} else if (this.loadingEl) {
			this.loadingEl.remove();
			this.loadingEl = undefined;
		}
	}

	private renderBlocks(msg: Message, isGenerating: boolean, messages: readonly Message[], stall?: MessageStall) {
		const visibleBlockIds = new Set<string>();
		let displayIndex = 0;
		let hasVisibleBlocks = false;

		for (let i = 0; i < msg.blocks.length; i++) {
			const block = msg.blocks[i];
			if (block.type === "reasoning" && this.config.showReasoning === false) continue;
			let definition: BlockRenderer | undefined;
			try {
				if (this.config.renderers?.length)
					definition = this.config.renderers.find((renderer) => renderer.matches(block, msg));
			} catch (error) {
				console.error("Block renderer failed", error);
			}
			if (!definition && (block.type === "reasoning" || block.type === "tool_result" || block.type === "artifact"))
				continue;
			const isLastBlock = i === msg.blocks.length - 1;
			const isGeneratingBlock = isGenerating && isLastBlock;

			let state = this.activeBlocks.get(block.id);
			const kind = block.type === "custom" ? block.kind : undefined;
			if (state && (state.type !== block.type || state.kind !== kind)) {
				this.destroyBlock(state);
				state.container.remove();
				this.activeBlocks.delete(block.id);
				state = undefined;
			}
			if (!state) {
				const container = el("div", `mur-content-block mur-block-${block.type}`);
				container.dataset.blockId = block.id;
				state = { container, type: block.type, kind };
				this.activeBlocks.set(block.id, state);
			}
			const container = state.container;

			const handledByPlugin =
				(definition !== undefined || state.definition !== undefined) &&
				this.renderWithRenderer(definition, block, state, msg, messages, i, isGeneratingBlock);
			// Built-in fallbacks expose only their displayed value; plugins use their block data.
			let progressValue: string | ContentBlock = block.type === "text" ? block.text : block;

			if (!handledByPlugin) {
				switch (block.type) {
					case "reasoning":
					case "tool_result":
					case "artifact":
						continue;
					case "text":
						this.renderTextBlock(block.text, state, msg, isGenerating);
						break;
					case "file":
						progressValue = this.renderFileBlock(block, container);
						break;
					case "tool_call":
						progressValue = this.renderToolFallback(block, container);
						break;
					case "custom":
						if (container.textContent !== block.fallbackText) container.textContent = block.fallbackText;
						progressValue = block.fallbackText;
						break;
				}
			}

			visibleBlockIds.add(block.id);
			if (!container.hidden) {
				hasVisibleBlocks = true;
				stall?.observe(
					block.id,
					progressValue,
					state.markdown !== undefined && state.markdown.rendered !== state.markdown.revision,
				);
			}

			if (this.blocksContainer.children[displayIndex] !== container) {
				this.blocksContainer.insertBefore(container, this.blocksContainer.children[displayIndex]);
			}
			displayIndex++;
		}

		// Remove blocks that were deleted or are now hidden by the display settings.
		for (const [id, state] of this.activeBlocks.entries()) {
			if (!visibleBlockIds.has(id)) {
				state.container.remove();
				this.destroyBlock(state);
				this.activeBlocks.delete(id);
			}
		}
		return hasVisibleBlocks;
	}

	private renderWithRenderer(
		definition: BlockRenderer | undefined,
		block: ContentBlock,
		state: BlockState,
		message: Message,
		messages: readonly Message[],
		blockIndex: number,
		isGenerating: boolean,
	): boolean {
		try {
			if (state.definition !== definition) {
				this.destroyBlock(state);
				state.container.textContent = "";
				state.container.className = `mur-content-block mur-block-${block.type}`;
				state.definition = definition;
			}
			if (!definition) return false;
			state.renderer ??= definition.mount(state.container);
			const renderer = state.renderer;
			const conversationId = this.config.getConversationId?.() ?? "";
			const context: RendererContext = {
				labels: this.config.labels ?? defaultLabels,
				message,
				messages,
				blockIndex,
				isGenerating,
				canAct: this.config.canAct?.() !== false,
				dispatch: (action, payload) => {
					if (this.isDestroyed || state.renderer !== renderer || this.config.canAct?.() === false) return;
					this.config.onAction?.({ conversationId, messageId: message.id, blockId: block.id, action, payload });
				},
			};
			renderer.update(block, context);
			return true;
		} catch (error) {
			console.error("Block renderer failed", error);
			this.destroyBlock(state);
			state.definition = undefined;
			state.container.textContent = "";
			return false;
		}
	}

	private destroyBlock(state: BlockState): void {
		if (state.markdown?.timer !== undefined) clearTimeout(state.markdown.timer);
		if (state.markdown) this.resolveMarkdownWait(state.markdown);
		state.markdown = undefined;
		const renderer = state.renderer;
		state.renderer = undefined;
		try {
			renderer?.destroy();
		} catch (error) {
			console.error("Block renderer failed during destroy", error);
		}
	}

	private renderTextBlock(text: string, state: BlockState, message: Message, streaming: boolean): void {
		state.markdown ??= { latest: text, role: message.role, streaming, revision: 0 };
		const markdown = state.markdown;
		if (
			markdown.latest !== text ||
			markdown.role !== message.role ||
			(this.config.markdown?.decorate && markdown.streaming !== streaming)
		) {
			markdown.latest = text;
			markdown.revision++;
			this.resolveMarkdownWait(markdown);
		}
		markdown.role = message.role;
		markdown.streaming = streaming;
		if (markdown.rendered === markdown.revision || markdown.pending === markdown.revision) return;
		if (!streaming) {
			void this.applyMarkdown(state, markdown);
		} else if (markdown.timer === undefined) {
			markdown.timer = setTimeout(() => void this.applyMarkdown(state, markdown), MARKDOWN_THROTTLE_MS);
		}
	}

	private async applyMarkdown(state: BlockState, markdown: MarkdownState): Promise<void> {
		if (markdown.timer !== undefined) clearTimeout(markdown.timer);
		markdown.timer = undefined;
		const text = markdown.latest;
		const revision = markdown.revision;
		const isCurrent = () => state.markdown === markdown && revision === markdown.revision;
		markdown.pending = revision;
		try {
			const next = await renderMarkdownContent(
				text,
				{
					message: this.currentMessage!,
					streaming: markdown.streaming,
					markdown: this.config.markdown,
					highlighter: this.config.highlighter,
					labels: this.config.labels,
				},
				isCurrent,
			);
			if (!isCurrent()) return;
			syncDOMChildren(state.container, next);
		} catch (error) {
			console.error("Failed to render markdown", error);
			if (isCurrent()) state.container.textContent = text;
		} finally {
			if (markdown.pending === revision) markdown.pending = undefined;
			if (isCurrent()) {
				markdown.rendered = revision;
				this.stall?.rendered(state.container.dataset.blockId!, text);
				this.resolveMarkdownWait(markdown);
			}
		}
	}

	private resolveMarkdownWait(markdown: MarkdownState): void {
		if (!markdown.resolveWaiting) return;
		markdown.resolveWaiting();
		markdown.waiting = undefined;
		markdown.resolveWaiting = undefined;
	}

	private renderFileBlock(block: Extract<ContentBlock, { type: "file" }>, container: HTMLElement) {
		if (block.mimeType.startsWith("image/")) {
			let img = container.querySelector("img");
			if (!img) {
				img = el("img", "mur-attachment-image");
				container.replaceChildren(img);
			}
			if (img.getAttribute("src") !== block.data) img.src = block.data;
			if (img.alt !== (block.name ?? "")) img.alt = block.name ?? "";
			return block;
		} else {
			let pill = container.querySelector(".mur-attachment-file-pill");
			if (!pill) {
				pill = el("div", "mur-attachment-file-pill");
				container.replaceChildren(pill);
			}
			const label = `📄 ${block.name || (this.config.labels ?? defaultLabels).file}`;
			if (pill.textContent !== label) pill.textContent = label;
			return label;
		}
	}

	private renderToolFallback(block: Extract<ContentBlock, { type: "tool_call" }>, container: HTMLElement): string {
		const labels = this.config.labels ?? defaultLabels;
		const text = `🛠 ${labels.toolCall(block.name, labels.toolStatus(block.status))}`;
		const className = `mur-content-block mur-block-tool mur-tool-${block.status}`;
		if (container.textContent !== text) container.textContent = text;
		if (container.className !== className) container.className = className;
		return text;
	}

	private renderError(error: string | null) {
		if (!error) {
			if (this.errorEl) this.errorEl.hidden = true;
			this.lastError = null;
			return;
		}

		if (!this.errorEl) {
			this.errorEl = el("div", "mur-message-error");
			this.el.appendChild(this.errorEl);
		}

		if (this.lastError !== error) {
			this.errorEl.textContent = `⚠ ${error}`;
			this.errorEl.hidden = false;
			this.lastError = error;
		}
	}

	private renderActions(msg: Message, isGenerating: boolean) {
		// Reconcile after content changes or completion, never on streaming tokens.
		const canAct = this.config.canAct?.() !== false;
		const hasContent = msg.blocks.length > 0;
		if (!isGenerating) this.reconcileActions(msg);
		else if (canAct === this.lastCanAct && hasContent === this.lastHasActionContent) return;
		this.lastCanAct = canAct;
		this.lastHasActionContent = hasContent;
		for (const { button, definition } of this.actionButtons.values()) {
			const disabled = !canAct && definition.mutates !== false;
			if (button.disabled !== disabled) button.disabled = disabled;
		}
		if (this.actionsEl) {
			const hidden = !hasContent || this.actionButtons.size === 0;
			if (this.actionsEl.hidden !== hidden) this.actionsEl.hidden = hidden;
		}
	}

	private reconcileActions(msg: Message): void {
		const focused = this.actionsEl?.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
		const keys = new Set<string>();
		let position = 0;
		for (const [pluginIndex, plugin] of this.config.plugins.entries()) {
			let defs: ActionButtonDef[] = [];
			try {
				if (msg.blocks.length) defs = plugin.getActionButtons?.(msg, this.config.labels ?? defaultLabels) ?? [];
			} catch (error) {
				console.error(`Plugin "${plugin.name}" failed during getActionButtons`, error);
			}
			for (const def of defs) {
				const key = JSON.stringify([pluginIndex, def.id]);
				if (keys.has(key)) continue;
				keys.add(key);
				let state = this.actionButtons.get(key);
				if (!state) {
					state = this.createActionButton(key, plugin.name, def);
					this.actionButtons.set(key, state);
				} else {
					if (state.button.title !== def.title) state.button.title = def.title;
					// Preserve transient feedback (e.g. Copy's checkmark) while the
					// definition's icon stays the same.
					if (state.iconHtml !== def.iconHtml) state.button.innerHTML = def.iconHtml;
					state.iconHtml = def.iconHtml;
					state.definition = def;
				}
				if (!this.actionsEl) {
					this.actionsEl = el("div", "mur-message-actions");
					this.el.appendChild(this.actionsEl);
				}
				if (this.actionsEl.children[position] !== state.button) {
					this.actionsEl.insertBefore(state.button, this.actionsEl.children[position]);
				}
				position++;
			}
		}
		for (const [key, state] of this.actionButtons) {
			if (keys.has(key)) continue;
			state.button.remove();
			this.actionButtons.delete(key);
		}
		if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
	}

	private createActionButton(key: string, pluginName: string, def: ActionButtonDef): ActionState {
		const btn = el("button", "mur-action-icon-btn", {
			type: "button",
			title: def.title,
			innerHTML: def.iconHtml,
		});
		const state = { button: btn, definition: def, iconHtml: def.iconHtml };
		btn.dataset.actionId = def.id;
		btn.dataset.pluginName = pluginName;
		btn.addEventListener("click", () => {
			if (
				this.isDestroyed ||
				!this.currentMessage ||
				this.actionsEl?.hidden ||
				this.actionButtons.get(key) !== state ||
				(this.config.canAct?.() === false && state.definition.mutates !== false)
			)
				return;
			state.definition.onClick({
				message: this.currentMessage,
				buttonEl: btn,
				messageEl: this.el,
				actionId: def.id,
				pluginName,
			});
		});

		return state;
	}
}
