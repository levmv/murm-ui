import type { ChatPlugin } from "../core/types";
import { IS_TOUCH_DEVICE } from "../utils/device";
import { queryOrThrow } from "../utils/dom";

export interface InputProps {
	container: HTMLElement;
	onSubmit: (text: string) => void;
	onStop: () => void;
}

export class Input {
	private form: HTMLFormElement;
	private input: HTMLTextAreaElement;
	private sendBtn: HTMLButtonElement;
	private isGenerating = false;
	private shouldRestoreFocus = false;

	private supportsFieldSizing = typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");

	private onInputBound = this.adjustHeight.bind(this);
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
				plugin.onInputMount({ form: this.form });
			}
		}

		this.bindEvents();
	}

	public focus() {
		if (!IS_TOUCH_DEVICE) {
			// Timeout ensures focus works correctly after DOM reflows
			// or when transitioning state (e.g., stopping generation)
			setTimeout(() => {
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
		this.sendBtn.disabled = isLoadingSession;
		this.sendBtn.classList.toggle("mur-generating", isGenerating);

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
	}

	public destroy() {
		this.input.removeEventListener("input", this.onInputBound);
		this.input.removeEventListener("keydown", this.onKeydownBound);
		this.form.removeEventListener("submit", this.onSubmitBound);
	}

	private bindEvents() {
		if (!this.supportsFieldSizing) {
			this.input.addEventListener("input", this.onInputBound);
		}
		this.input.addEventListener("keydown", this.onKeydownBound);
		this.form.addEventListener("submit", this.onSubmitBound);
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

		const text = this.input.value.trim();
		const hasPluginData = this.plugins.some((p) => p.hasPendingData?.());

		if (!text && !hasPluginData) return;

		this.shouldRestoreFocus = true;

		this.input.value = "";
		if (!this.supportsFieldSizing) {
			this.adjustHeight();
		}

		this.props.onSubmit(text);
	}
}
