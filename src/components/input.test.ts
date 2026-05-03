import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { ChatPlugin, PluginInputContext } from "../core/types";
import { Input } from "./input";

function setGlobal(name: string, value: unknown): void {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
		writable: true,
	});
}

function installDom(): HTMLElement {
	const dom = new JSDOM(`
		<div class="mur-app">
			<form class="mur-chat-form">
				<textarea class="mur-chat-input" rows="1"></textarea>
				<button type="submit" class="mur-send-btn">Send</button>
			</form>
		</div>
	`);

	Object.defineProperty(dom.window, "matchMedia", {
		configurable: true,
		value: () => ({ matches: false }),
	});

	setGlobal("window", dom.window);
	setGlobal("document", dom.window.document);
	setGlobal("navigator", dom.window.navigator);
	setGlobal("HTMLElement", dom.window.HTMLElement);
	setGlobal("Event", dom.window.Event);
	setGlobal("CSS", { supports: () => false });

	return dom.window.document.querySelector(".mur-app") as HTMLElement;
}

function mountInput(
	plugins: ChatPlugin[] = [],
	onSubmit?: (text: string, submissions: string[]) => boolean,
	onStop: () => void = () => {},
): {
	form: HTMLFormElement;
	input: HTMLTextAreaElement;
	sendBtn: HTMLButtonElement;
	submissions: string[];
	focus: () => void;
	setGeneratingState: (isGenerating: boolean, isLoadingSession: boolean) => void;
	destroy: () => void;
} {
	const container = installDom();
	const submissions: string[] = [];
	const inputComponent = new Input(
		{
			container,
			onSubmit: (text) => {
				if (onSubmit) return onSubmit(text, submissions);
				submissions.push(text);
				return true;
			},
			onStop,
		},
		plugins,
	);

	return {
		form: container.querySelector(".mur-chat-form") as HTMLFormElement,
		input: container.querySelector(".mur-chat-input") as HTMLTextAreaElement,
		sendBtn: container.querySelector(".mur-send-btn") as HTMLButtonElement,
		submissions,
		focus: () => inputComponent.focus(),
		setGeneratingState: (isGenerating, isLoadingSession) =>
			inputComponent.setGeneratingState(isGenerating, isLoadingSession),
		destroy: () => inputComponent.destroy(),
	};
}

function setInputValue(input: HTMLTextAreaElement, value: string): void {
	input.value = value;
	input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function submit(form: HTMLFormElement): void {
	form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

test("send button is disabled without text or pending plugin data", () => {
	const harness = mountInput();

	assert.equal(harness.sendBtn.disabled, true);

	setInputValue(harness.input, "   ");
	assert.equal(harness.sendBtn.disabled, true);

	setInputValue(harness.input, "hello");
	assert.equal(harness.sendBtn.disabled, false);

	submit(harness.form);
	assert.deepEqual(harness.submissions, ["hello"]);
	assert.equal(harness.input.value, "");
	assert.equal(harness.sendBtn.disabled, true);

	harness.destroy();
});

test("pending plugin data enables empty submissions", () => {
	let pending = false;
	const inputContext: { current?: PluginInputContext } = {};
	const plugin: ChatPlugin = {
		name: "pending-data",
		onInputMount: (ctx) => {
			inputContext.current = ctx;
		},
		hasPendingData: () => pending,
	};
	const harness = mountInput([plugin]);

	assert.equal(harness.sendBtn.disabled, true);

	pending = true;
	inputContext.current?.requestSubmitStateSync();
	assert.equal(harness.sendBtn.disabled, false);

	pending = false;
	inputContext.current?.requestSubmitStateSync();
	assert.equal(harness.sendBtn.disabled, true);

	harness.destroy();
});

test("input changes only resync submit state when text availability changes", () => {
	let blockedChecks = 0;
	let pendingChecks = 0;
	const plugin: ChatPlugin = {
		name: "sync-counter",
		isSubmitBlocked: () => {
			blockedChecks++;
			return false;
		},
		hasPendingData: () => {
			pendingChecks++;
			return false;
		},
	};
	const harness = mountInput([plugin]);

	assert.equal(blockedChecks, 1);
	assert.equal(pendingChecks, 1);

	setInputValue(harness.input, "h");
	assert.equal(blockedChecks, 2);
	assert.equal(pendingChecks, 1);

	setInputValue(harness.input, "he");
	setInputValue(harness.input, "hello");
	assert.equal(blockedChecks, 2);
	assert.equal(pendingChecks, 1);

	setInputValue(harness.input, "");
	assert.equal(blockedChecks, 3);
	assert.equal(pendingChecks, 2);

	setInputValue(harness.input, " ");
	assert.equal(blockedChecks, 3);
	assert.equal(pendingChecks, 2);

	harness.destroy();
});

test("submit refreshes stale text state from programmatic value changes", () => {
	const harness = mountInput();

	harness.input.value = "programmatic";
	submit(harness.form);
	assert.deepEqual(harness.submissions, ["programmatic"]);
	assert.equal(harness.sendBtn.disabled, true);

	setInputValue(harness.input, "visible");
	assert.equal(harness.sendBtn.disabled, false);

	harness.input.value = "";
	submit(harness.form);
	assert.deepEqual(harness.submissions, ["programmatic"]);
	assert.equal(harness.sendBtn.disabled, true);

	harness.destroy();
});

test("textarea fallback height uses the computed max-height", () => {
	const harness = mountInput();
	harness.input.style.maxHeight = "120px";
	Object.defineProperty(harness.input, "scrollHeight", {
		configurable: true,
		value: 300,
	});

	setInputValue(harness.input, "hello\n".repeat(20));

	assert.equal(harness.input.style.height, "120px");

	harness.destroy();
});

test("rejected submissions keep the input text and enabled state", () => {
	const harness = mountInput([], (text, submissions) => {
		submissions.push(text);
		return false;
	});

	setInputValue(harness.input, "keep me");
	submit(harness.form);

	assert.deepEqual(harness.submissions, ["keep me"]);
	assert.equal(harness.input.value, "keep me");
	assert.equal(harness.sendBtn.disabled, false);

	harness.destroy();
});

test("textarea stays editable while generating and draft submits afterward", () => {
	let stopCalls = 0;
	const harness = mountInput([], undefined, () => {
		stopCalls++;
	});

	harness.setGeneratingState(true, false);

	assert.equal(harness.input.disabled, false);
	assert.equal(harness.sendBtn.disabled, false);

	setInputValue(harness.input, "draft");
	assert.equal(harness.input.value, "draft");

	submit(harness.form);

	assert.equal(stopCalls, 1);
	assert.deepEqual(harness.submissions, []);
	assert.equal(harness.input.value, "draft");

	harness.setGeneratingState(false, false);

	assert.equal(harness.sendBtn.disabled, false);

	submit(harness.form);

	assert.deepEqual(harness.submissions, ["draft"]);
	assert.equal(harness.input.value, "");

	harness.destroy();
});

test("textarea stays editable while loading a session but submit stays disabled", () => {
	const harness = mountInput();

	harness.setGeneratingState(false, true);

	assert.equal(harness.input.disabled, false);
	assert.equal(harness.sendBtn.disabled, true);

	setInputValue(harness.input, "draft");
	assert.equal(harness.input.value, "draft");
	assert.equal(harness.sendBtn.disabled, true);

	submit(harness.form);

	assert.deepEqual(harness.submissions, []);
	assert.equal(harness.input.value, "draft");

	harness.setGeneratingState(false, false);

	assert.equal(harness.sendBtn.disabled, false);

	submit(harness.form);

	assert.deepEqual(harness.submissions, ["draft"]);
	assert.equal(harness.input.value, "");

	harness.destroy();
});

test("focus schedules focus without requiring an enabled state", () => {
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const timeoutId = {} as ReturnType<typeof setTimeout>;
	let pendingFocus: (() => void) | null = null;
	const runPendingFocus = () => {
		const callback = pendingFocus;
		if (callback) callback();
	};

	setGlobal("setTimeout", ((handler: TimerHandler) => {
		pendingFocus = typeof handler === "function" ? (handler as () => void) : () => {};
		return timeoutId;
	}) as unknown as typeof setTimeout);
	setGlobal("clearTimeout", (() => {
		pendingFocus = null;
	}) as unknown as typeof clearTimeout);

	try {
		const harness = mountInput();
		let focusCalls = 0;
		harness.input.focus = () => {
			focusCalls++;
		};

		harness.focus();
		harness.setGeneratingState(false, true);
		runPendingFocus();

		assert.equal(focusCalls, 1);

		harness.destroy();
	} finally {
		setGlobal("setTimeout", originalSetTimeout);
		setGlobal("clearTimeout", originalClearTimeout);
	}
});

test("destroy cancels a pending focus timeout", () => {
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const timeoutId = {} as ReturnType<typeof setTimeout>;
	let pendingFocus: (() => void) | null = null;
	let clearedTimeout: ReturnType<typeof setTimeout> | null = null;
	const runPendingFocus = () => {
		const callback = pendingFocus;
		if (callback) callback();
	};

	setGlobal("setTimeout", ((handler: TimerHandler) => {
		pendingFocus = typeof handler === "function" ? (handler as () => void) : () => {};
		return timeoutId;
	}) as unknown as typeof setTimeout);
	setGlobal("clearTimeout", ((id?: ReturnType<typeof setTimeout>) => {
		clearedTimeout = id ?? null;
		pendingFocus = null;
	}) as unknown as typeof clearTimeout);

	try {
		const harness = mountInput();
		let focusCalls = 0;
		harness.input.focus = () => {
			focusCalls++;
		};

		harness.focus();
		harness.destroy();
		runPendingFocus();

		assert.equal(clearedTimeout, timeoutId);
		assert.equal(focusCalls, 0);
	} finally {
		setGlobal("setTimeout", originalSetTimeout);
		setGlobal("clearTimeout", originalClearTimeout);
	}
});
