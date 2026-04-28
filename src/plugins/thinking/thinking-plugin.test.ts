import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { ThinkingPlugin } from "./thinking-plugin";

function setGlobal(name: string, value: unknown): void {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
		writable: true,
	});
}

function installDom(): void {
	const dom = new JSDOM("");
	setGlobal("document", dom.window.document);
	setGlobal("DOMParser", dom.window.DOMParser);
	setGlobal("NodeFilter", dom.window.NodeFilter);
	setGlobal("HTMLElement", dom.window.HTMLElement);
}

test("ThinkingPlugin shows fallback instead of encrypted reasoning text", () => {
	installDom();
	const plugin = ThinkingPlugin();
	const container = document.createElement("div");

	assert.ok(plugin.onBlockRender);
	const handled = plugin.onBlockRender(
		{ id: "reasoning-1", type: "reasoning", text: "ciphertext", encrypted: true, encryptedText: "opaque-state" },
		container,
		false,
	);
	assert.equal(handled, true);

	const button = container.querySelector("button");
	assert.ok(button);
	button.click();

	assert.match(container.textContent ?? "", /Thought process is hidden by the model provider/);
	assert.doesNotMatch(container.textContent ?? "", /ciphertext/);
	assert.doesNotMatch(container.textContent ?? "", /opaque-state/);
});
