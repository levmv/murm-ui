import type {
	ComposerCapabilities,
	ComposerContext,
	ComposerExtension,
	ComposerPlugin,
	SubmitCommand,
} from "../core/composer-types";
import { type ChatLabels, defaultLabels } from "../labels";
import { IS_TOUCH_DEVICE } from "../utils/device";
import { el, queryOrThrow } from "../utils/dom";
import { ICON_SEND, ICON_STOP } from "../utils/icons";
import { uuidv7 } from "../utils/uuid";

export interface ComposerConfig {
	container: HTMLElement | string;
	/** Adopt an existing form inside container. */
	form?: HTMLFormElement;
	plugins?: ComposerPlugin[];
	labels?: Partial<ChatLabels>;
	/** Resolves on acceptance, independently of run completion. False or rejection retains the draft. */
	// biome-ignore lint/suspicious/noConfusingVoidType: Submission may accept without a return value.
	onSubmit: (command: SubmitCommand) => boolean | void | Promise<boolean | void>;
	onStop?: (command: { conversationId: string }) => void | Promise<void>;
}

interface DraftState {
	text: string;
	revision: number;
	textRevision: number;
	pending?: boolean;
	stopping?: boolean;
	error?: string;
	lastRequest?: { id: string; revision: number };
}

/** Text input and acceptance state. Extensions own their additional draft content. */
export class Composer {
	readonly element: HTMLElement;
	private readonly form: HTMLFormElement;
	private readonly input: HTMLTextAreaElement;
	private readonly sendButton: HTMLButtonElement;
	private readonly labels: Readonly<ChatLabels>;
	private readonly errorEl: HTMLElement;
	private readonly drafts = new Map<string, DraftState>();
	private readonly extensions: ComposerExtension[] = [];
	private readonly submissions = new Set<AbortController>();
	private conversationId = "";
	private capabilities: ComposerCapabilities = { canSubmit: true, canStop: false };
	private hasText = false;
	private epoch = 0;
	private destroyed = false;
	private readonly ownsElement: boolean;
	private readonly supportsFieldSizing = typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");
	private focusTimeout?: ReturnType<typeof setTimeout>;

	constructor(private readonly config: ComposerConfig) {
		const host =
			typeof config.container === "string" ? document.querySelector<HTMLElement>(config.container) : config.container;
		if (!host) throw new Error(`Composer container not found: ${config.container}`);
		if (config.form && !host.contains(config.form)) throw new Error("Composer form must be inside its container");
		this.ownsElement = !config.form;
		this.labels = config.labels ? { ...defaultLabels, ...config.labels } : defaultLabels;
		this.form =
			config.form ??
			el("form", "mur-chat-form", null, [
				el("textarea", "mur-chat-input", { rows: 1, placeholder: this.labels.messagePlaceholder }),
				el("button", "mur-send-btn mur-form-icon-btn mur-action-btn", {
					type: "submit",
					innerHTML: ICON_SEND + ICON_STOP,
				}),
			]);
		this.input = queryOrThrow<HTMLTextAreaElement>(this.form, ".mur-chat-input");
		this.sendButton = queryOrThrow<HTMLButtonElement>(this.form, ".mur-send-btn");
		if (
			!this.input.hasAttribute("aria-label") &&
			!this.input.hasAttribute("aria-labelledby") &&
			!this.input.labels?.length
		)
			this.input.setAttribute("aria-label", this.labels.message);
		this.errorEl = el("div", "mur-composer-error", { hidden: true });
		this.errorEl.setAttribute("role", "alert");
		if (config.form) {
			this.element = this.form.parentElement!;
			this.form.after(this.errorEl);
		} else {
			this.element = el("div", "mur-composer", null, [this.form, this.errorEl]);
			host.appendChild(this.element);
		}
		const composer = this;
		const context: ComposerContext = {
			container: config.form ? host : this.element,
			form: this.form,
			input: this.input,
			labels: this.labels,
			get conversationId() {
				return composer.conversationId;
			},
			get canEdit() {
				return composer.canEdit;
			},
			changed(id = composer.conversationId) {
				if (composer.destroyed) return;
				composer.draftState(id).revision++;
				if (id === composer.conversationId) composer.syncButton();
			},
		};
		for (const plugin of config.plugins ?? []) {
			const extension = plugin.mountComposer?.(context);
			if (extension) this.extensions.push(extension);
		}
		this.input.addEventListener("input", this.onInput);
		this.input.addEventListener("keydown", this.onKeydown);
		this.form.addEventListener("submit", this.onSubmit);
		this.sync();
	}

	setConversation(id: string, capabilities: Partial<ComposerCapabilities> = {}): void {
		this.assertAlive();
		this.epoch++;
		if (id !== this.conversationId) {
			this.conversationId = id;
			this.setText(this.draftState().text);
		}
		this.capabilities = { canSubmit: true, canStop: false, ...capabilities };
		this.sync();
	}

	setCapabilities(capabilities: Partial<ComposerCapabilities>): void {
		this.assertAlive();
		const previous = this.capabilities;
		this.capabilities = { ...previous, ...capabilities };
		if (
			previous.canSubmit !== this.capabilities.canSubmit ||
			previous.canStop !== this.capabilities.canStop ||
			previous.canEdit !== this.capabilities.canEdit
		)
			this.sync();
	}

	getDraft(conversationId = this.conversationId): string {
		return this.draftState(conversationId).text;
	}

	setDraft(text: string): void {
		this.assertAlive();
		const state = this.draftState();
		state.text = text;
		state.revision++;
		state.textRevision++;
		state.error = undefined;
		this.setText(text);
		this.sync();
	}

	async submit(): Promise<void> {
		this.assertAlive();
		this.readText();
		if (!this.canSubmit()) return;
		const state = this.draftState();
		const { revision, textRevision, text } = state;
		const conversationId = this.conversationId;
		const controller = new AbortController();
		state.pending = true;
		state.error = undefined;
		this.submissions.add(controller);
		try {
			const parts = this.extensions.flatMap((extension) => (extension.collect ? [extension.collect()] : []));
			const clientRequestId = state.lastRequest?.revision === revision ? state.lastRequest.id : uuidv7();
			state.lastRequest = { id: clientRequestId, revision };
			this.sync();
			const acceptance = this.config.onSubmit({
				conversationId,
				clientRequestId,
				text,
				blocks: parts.flatMap((part) => part.blocks),
				signal: controller.signal,
			});
			const accepted = typeof acceptance === "object" ? await acceptance : acceptance;
			if (this.destroyed || accepted === false) return;
			if (state.textRevision === textRevision) {
				state.text = "";
				state.textRevision++;
				if (conversationId === this.conversationId) this.setText("");
			}
			for (const part of parts) part.accept();
			state.revision++;
		} catch (error) {
			if (!this.destroyed && !controller.signal.aborted) state.error = errorText(error);
		} finally {
			state.pending = false;
			this.submissions.delete(controller);
			if (!this.destroyed && conversationId === this.conversationId) this.sync();
		}
	}

	async stop(): Promise<void> {
		this.assertAlive();
		const conversationId = this.conversationId;
		const state = this.draftState();
		if (!conversationId || !this.capabilities.canStop || !this.config.onStop || state.stopping) return;
		const epoch = this.epoch;
		state.stopping = true;
		state.error = undefined;
		this.sync();
		try {
			await this.config.onStop({ conversationId });
		} catch (error) {
			if (!this.destroyed && epoch === this.epoch) state.error = errorText(error);
		} finally {
			state.stopping = false;
			if (!this.destroyed && conversationId === this.conversationId) this.sync();
		}
	}

	focus(): void {
		this.assertAlive();
		clearTimeout(this.focusTimeout);
		this.input.focus({ preventScroll: true });
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		clearTimeout(this.focusTimeout);
		this.input.removeEventListener("input", this.onInput);
		this.input.removeEventListener("keydown", this.onKeydown);
		this.form.removeEventListener("submit", this.onSubmit);
		for (const controller of this.submissions) controller.abort();
		this.submissions.clear();
		for (const extension of this.extensions) {
			try {
				extension.destroy();
			} catch (error) {
				console.error("Composer extension failed during destroy", error);
			}
		}
		this.extensions.length = 0;
		this.drafts.clear();
		if (this.ownsElement) this.element.remove();
		else this.errorEl.remove();
	}

	private get canEdit(): boolean {
		return Boolean(this.conversationId) && (this.capabilities.canEdit ?? this.capabilities.canSubmit);
	}

	private draftState(id = this.conversationId): DraftState {
		let state = this.drafts.get(id);
		if (!state) {
			state = { text: "", revision: 0, textRevision: 0 };
			this.drafts.set(id, state);
		}
		return state;
	}

	private readonly onInput = () => {
		const hadText = this.hasText;
		this.readText();
		this.adjustHeight();
		if (hadText !== this.hasText) this.syncButton();
	};

	private readonly onKeydown = (event: KeyboardEvent) => {
		if (event.key !== "Enter" || event.shiftKey || event.isComposing || IS_TOUCH_DEVICE) return;
		event.preventDefault();
		this.send(false);
	};

	private readonly onSubmit = (event: Event) => {
		event.preventDefault();
		this.send(true);
	};

	private send(allowStop: boolean): void {
		this.readText();
		if (this.isStopAction()) {
			if (allowStop) void this.stop();
		} else if (this.canSubmit()) {
			if (!IS_TOUCH_DEVICE) {
				clearTimeout(this.focusTimeout);
				this.focusTimeout = setTimeout(() => this.focus(), 0);
			}
			void this.submit();
		}
	}

	private readText(): void {
		const state = this.draftState();
		if (state.text !== this.input.value) {
			state.text = this.input.value;
			state.revision++;
			state.textRevision++;
		}
		this.hasText = /\S/.test(state.text);
	}

	private setText(text: string): void {
		this.input.value = text;
		this.hasText = /\S/.test(text);
		this.adjustHeight();
	}

	private adjustHeight(): void {
		if (this.supportsFieldSizing) return;
		this.input.style.height = "auto";
		const maxHeight = Number.parseFloat(window.getComputedStyle(this.input).maxHeight);
		this.input.style.height = `${Math.min(this.input.scrollHeight, Number.isFinite(maxHeight) && maxHeight > 0 ? maxHeight : 200)}px`;
	}

	private hasContent(): boolean {
		return this.hasText || this.extensions.some((extension) => extension.hasContent?.());
	}

	private canSubmit(): boolean {
		return (
			Boolean(this.conversationId) &&
			this.capabilities.canSubmit &&
			!this.draftState().pending &&
			this.hasContent() &&
			!this.extensions.some((extension) => extension.isBlocked?.())
		);
	}

	private isStopAction(): boolean {
		return (
			Boolean(this.config.onStop && this.capabilities.canStop) && (!this.capabilities.canSubmit || !this.hasContent())
		);
	}

	private syncButton(): void {
		const stop = this.isStopAction();
		const label = stop ? this.labels.stop : this.labels.send;
		this.sendButton.classList.toggle("mur-generating", stop);
		this.sendButton.setAttribute("aria-label", label);
		this.sendButton.title = label;
		this.sendButton.disabled = stop ? Boolean(this.draftState().stopping) : !this.canSubmit();
	}

	private sync(): void {
		const state = this.draftState();
		this.input.readOnly = !this.canEdit;
		this.form.setAttribute("aria-busy", String(Boolean(state.pending || state.stopping)));
		this.syncButton();
		this.errorEl.hidden = !state.error;
		if (this.errorEl.textContent !== (state.error ?? "")) this.errorEl.textContent = state.error ?? "";
		for (const extension of this.extensions) extension.update?.();
	}

	private assertAlive(): void {
		if (this.destroyed) throw new Error("Composer has been destroyed");
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
