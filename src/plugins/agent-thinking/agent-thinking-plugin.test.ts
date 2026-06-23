import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { AgentThinkingPlugin } from "./agent-thinking-plugin";

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
	setGlobal("HTMLElement", dom.window.HTMLElement);
}

test("AgentThinkingPlugin renders reasoning as an inline expandable preview", () => {
	installDom();
	const plugin = AgentThinkingPlugin({ previewLines: 2 });
	const container = document.createElement("div");
	const text = "First line\nSecond line\nThird line\nFourth line";

	assert.ok(plugin.onBlockRender);
	const handled = plugin.onBlockRender({ id: "reasoning-1", type: "reasoning", text }, container, false);
	assert.equal(handled, true);

	const preview = container.querySelector<HTMLElement>(".mur-agent-think-preview");
	assert.ok(preview);
	assert.equal(container.querySelector(".mur-think-toggle"), null);
	assert.equal(preview.dataset.expandable, "true");
	assert.equal(preview.getAttribute("role"), "button");
	assert.equal(preview.getAttribute("aria-expanded"), "false");
	assert.equal(preview.style.getPropertyValue("--mur-agent-think-preview-lines"), "2");
	assert.equal(container.textContent, text);

	preview.click();
	assert.equal(preview.getAttribute("aria-expanded"), "true");

	preview.click();
	assert.equal(preview.getAttribute("aria-expanded"), "false");
});

test("AgentThinkingPlugin keeps short reasoning non-interactive", () => {
	installDom();
	const plugin = AgentThinkingPlugin({ previewLines: 3 });
	const container = document.createElement("div");

	assert.ok(plugin.onBlockRender);
	const handled = plugin.onBlockRender(
		{ id: "reasoning-1", type: "reasoning", text: "Short thought." },
		container,
		false,
	);
	assert.equal(handled, true);

	const preview = container.querySelector<HTMLElement>(".mur-agent-think-preview");
	assert.ok(preview);
	assert.equal(preview.dataset.expandable, "false");
	assert.equal(preview.getAttribute("role"), null);
	assert.equal(preview.getAttribute("aria-expanded"), null);
	assert.equal(preview.getAttribute("tabindex"), null);

	preview.click();
	assert.equal(preview.dataset.expanded, "false");
});

test("AgentThinkingPlugin hides encrypted reasoning payloads", () => {
	installDom();
	const plugin = AgentThinkingPlugin();
	const container = document.createElement("div");

	assert.ok(plugin.onBlockRender);
	const handled = plugin.onBlockRender(
		{ id: "reasoning-1", type: "reasoning", text: "ciphertext", encrypted: true, encryptedText: "opaque-state" },
		container,
		false,
	);
	assert.equal(handled, true);

	assert.match(container.textContent ?? "", /Thought process is hidden by the model provider/);
	assert.doesNotMatch(container.textContent ?? "", /ciphertext/);
	assert.doesNotMatch(container.textContent ?? "", /opaque-state/);
});
