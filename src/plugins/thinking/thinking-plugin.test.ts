import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { RendererContext } from "../../core/types";
import { ThinkingPlugin } from "./thinking-plugin";

const context: RendererContext = {
	message: { id: "assistant", role: "assistant", blocks: [] },
	messages: [],
	blockIndex: 0,
	isGenerating: false,
	canAct: true,
	dispatch() {},
};

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

test("opening reasoning after block replacement displays the latest content", () => {
	installDom();
	const plugin = ThinkingPlugin();
	const container = document.createElement("div");
	const renderer = plugin.renderers![0].mount(container);
	renderer.update({ id: "reason", type: "reasoning", text: "old" }, context);
	renderer.update({ id: "reason", type: "reasoning", text: "updated" }, context);
	const toggle = container.querySelector("button")!;
	toggle.click();
	assert.equal(container.querySelector(".mur-think-content")?.textContent, "updated");
	toggle.click();
	renderer.update(
		{ id: "reason", type: "reasoning", text: "secret", encrypted: true, encryptedText: "opaque-state" },
		context,
	);
	toggle.click();
	assert.match(container.textContent!, /hidden by the model provider/);
	assert.doesNotMatch(container.textContent!, /old|updated|secret|opaque-state/);
	renderer.destroy();
});
