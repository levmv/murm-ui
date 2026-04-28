import type { ChatPlugin } from "../core/types";
import { IS_TOUCH_DEVICE } from "../utils/device";
import { queryOrThrow } from "../utils/dom";

export interface InputProps {
	container: HTMLElement;
	onSubmit: (text: string) => boolean;
	onStop: () => void;
}

export class Input {
	private form: HTMLFormElement;
	private input: HTMLTextAreaElement;
	private sendBtn: HTMLButtonElement;
	private isGenerating = false;
	private hasSubmittableText = false;
	private shouldRestoreFocus = false;
	private focusTimeout: ReturnType<typeof setTimeout> | null = null;

	private supportsFieldSizing = typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");

	private onInputBound = this.handleInput.bind(this);
	private onKeydownBound = this.handleKeydown.bind(this);
	private onSubmitBound = this.handleFormSubmit.bind(this);

	constructor(
		private props: InputProps,
		private plugins: ChatPlugin[] = [],
	) {
		this.form = queryOrThrow<HTMLFormElement>(this.props.container, ".mur-chat-form");
		this.input = queryOrThrow<HTMLTextAreaElement>(this.props.container, ".mur-chat-input");
		this.sendBtn = queryOrThrow<HTMLButtonElement>(this.props.container, ".mur-send-btn");

		for (const plugin of plugins) {
			if (plugin.onInputMount) {
				plugin.onInputMount({
					container: this.props.container,
					form: this.form,
					input: this.input,
					requestSubmitStateSync: () => this.syncSubmitState(),
				});
			}
		}

		this.bindEvents();
		this.refreshTextState();
		this.syncSubmitState();
	}

	public focus() {
		if (!IS_TOUCH_DEVICE) {
			// Timeout ensures focus works correctly after DOM reflows
			// or when transitioning state (e.g., stopping generation)
			this.clearPendingFocus();
			this.focusTimeout = setTimeout(() => {
				this.focusTimeout = null;
				if (!this.input.disabled) {
					this.input.focus({ preventScroll: true });
				}
			}, 0);
		}
	}

	public setGeneratingState(isGenerating: boolean, isLoadingSession: boolean) {
		const disabled = isGenerating || isLoadingSession;
		const endedGeneration = this.isGenerating && !isGenerating;

		this.isGenerating = isGenerating;
		this.input.disabled = disabled;
		this.sendBtn.classList.toggle("mur-generating", isGenerating);
		this.syncSubmitState(isLoadingSession);

		if (endedGeneration && !disabled && this.shouldRestoreFocus) {
			this.focus();
			this.shouldRestoreFocus = false;
		}
	}

	public setText(text: string) {
		this.input.value = text;
		if (!this.supportsFieldSizing) {
			this.adjustHeight();
		}
		if (this.refreshTextState()) {
			this.syncSubmitState();
		}
	}

	public destroy() {
		this.clearPendingFocus();
		this.input.removeEventListener("input", this.onInputBound);
		this.input.removeEventListener("keydown", this.onKeydownBound);
		this.form.removeEventListener("submit", this.onSubmitBound);
	}

	private clearPendingFocus() {
		if (this.focusTimeout === null) return;
		clearTimeout(this.focusTimeout);
		this.focusTimeout = null;
	}

	private bindEvents() {
		this.input.addEventListener("input", this.onInputBound);
		this.input.addEventListener("keydown", this.onKeydownBound);
		this.form.addEventListener("submit", this.onSubmitBound);
	}

	private handleInput() {
		if (!this.supportsFieldSizing) {
			this.adjustHeight();
		}
		if (this.refreshTextState()) {
			this.syncSubmitState();
		}
	}

	private handleKeydown(e: KeyboardEvent) {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !IS_TOUCH_DEVICE) {
			e.preventDefault();
			this.handleSubmit();
		}
	}

	private handleFormSubmit(e: Event) {
		e.preventDefault();
		this.handleSubmit();
	}

	private adjustHeight() {
		const el = this.input;
		el.style.height = "auto"; // Force synchronous reflow to determine natural height
		const newHeight = Math.min(el.scrollHeight, 200);
		el.style.height = newHeight + "px";
	}

	private handleSubmit() {
		if (this.isGenerating) {
			this.props.onStop();
			return;
		}

		const textStateChanged = this.refreshTextState();
		const text = this.input.value.trim();

		if (!this.canSubmit()) {
			if (textStateChanged) {
				this.syncSubmitState();
			}
			return;
		}

		this.shouldRestoreFocus = true;

		if (!this.props.onSubmit(text)) {
			// Submission rejected, keep text and sync state
			this.syncSubmitState();
			return;
		}

		this.input.value = "";

		this.refreshTextState();
		if (!this.supportsFieldSizing) {
			this.adjustHeight();
		}

		this.syncSubmitState();
	}

	private syncSubmitState(isLoadingSession = this.input.disabled && !this.isGenerating) {
		if (isLoadingSession) {
			this.sendBtn.disabled = true;
			return;
		}

		if (this.isGenerating) {
			this.sendBtn.disabled = false;
			return;
		}

		this.sendBtn.disabled = !this.canSubmit();
	}

	private canSubmit(): boolean {
		return !this.isSubmitBlocked() && (this.hasSubmittableText || this.hasPendingPluginData());
	}

	private isSubmitBlocked(): boolean {
		return this.plugins.some((p) => p.isSubmitBlocked?.());
	}

	private hasPendingPluginData(): boolean {
		return this.plugins.some((p) => p.hasPendingData?.());
	}

	private refreshTextState(): boolean {
		const hasSubmittableText = /\S/.test(this.input.value);
		if (hasSubmittableText === this.hasSubmittableText) return false;

		this.hasSubmittableText = hasSubmittableText;
		return true;
	}
}
