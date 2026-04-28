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

function mountInput(plugins: ChatPlugin[] = []): {
	form: HTMLFormElement;
	input: HTMLTextAreaElement;
	sendBtn: HTMLButtonElement;
	submissions: string[];
	destroy: () => void;
} {
	const container = installDom();
	const submissions: string[] = [];
	const inputComponent = new Input(
		{
			container,
			onSubmit: (text) => submissions.push(text),
			onStop: () => {},
		},
		plugins,
	);

	return {
		form: container.querySelector(".mur-chat-form") as HTMLFormElement,
		input: container.querySelector(".mur-chat-input") as HTMLTextAreaElement,
		sendBtn: container.querySelector(".mur-send-btn") as HTMLButtonElement,
		submissions,
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
	let inputContext: PluginInputContext | null = null;
	const plugin: ChatPlugin = {
		name: "pending-data",
		onInputMount: (ctx) => {
			inputContext = ctx;
		},
		hasPendingData: () => pending,
	};
	const harness = mountInput([plugin]);

	assert.equal(harness.sendBtn.disabled, true);

	pending = true;
	inputContext?.requestSubmitStateSync();
	assert.equal(harness.sendBtn.disabled, false);

	pending = false;
	inputContext?.requestSubmitStateSync();
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
