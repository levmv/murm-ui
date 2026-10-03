import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { RendererContext } from "../../core/types";
import { AgentThinkingPlugin } from "./agent-thinking-plugin";

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
	setGlobal("HTMLElement", dom.window.HTMLElement);
}

test("AgentThinkingPlugin renders reasoning as an inline expandable preview", () => {
	installDom();
	const plugin = AgentThinkingPlugin({ previewLines: 2 });
	const container = document.createElement("div");
	const renderer = plugin.renderers![0].mount(container);
	const text = "First line\nSecond line\nThird line\nFourth line";

	renderer.update({ id: "reasoning-1", type: "reasoning", text }, context);

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

	// A paragraph can wrap past the preview limit without explicit newlines.
	const textEl = container.querySelector<HTMLElement>(".mur-agent-think-text")!;
	Object.defineProperties(textEl, {
		scrollHeight: { get: () => 80 },
		clientHeight: { get: () => (preview.dataset.expanded === "true" ? 80 : 32) },
	});
	const paragraph = "A long thought that wraps onto several lines.";
	renderer.update({ id: "reasoning-1", type: "reasoning", text: paragraph }, { ...context, isGenerating: true });
	assert.equal(preview.dataset.expandable, "true");
	preview.click();
	assert.equal(preview.getAttribute("aria-expanded"), "true");
	renderer.update(
		{ id: "reasoning-1", type: "reasoning", text: `${paragraph} More streamed text.` },
		{ ...context, isGenerating: true },
	);
	assert.equal(preview.getAttribute("aria-expanded"), "true");
	renderer.destroy();
});

test("AgentThinkingPlugin keeps short reasoning non-interactive", () => {
	installDom();
	const plugin = AgentThinkingPlugin({ previewLines: 3 });
	const container = document.createElement("div");
	const renderer = plugin.renderers![0].mount(container);

	renderer.update({ id: "reasoning-1", type: "reasoning", text: "Short thought." }, context);

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
	const renderer = plugin.renderers![0].mount(container);

	renderer.update(
		{ id: "reasoning-1", type: "reasoning", text: "ciphertext", encrypted: true, encryptedText: "opaque-state" },
		context,
	);

	assert.match(container.textContent ?? "", /Thought process is hidden by the model provider/);
	assert.doesNotMatch(container.textContent ?? "", /ciphertext/);
	assert.doesNotMatch(container.textContent ?? "", /opaque-state/);
});
