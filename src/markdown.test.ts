import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import type { Message } from "./core/types";
import { defaultLabels } from "./labels";
import { renderMarkdown } from "./markdown";

const dom = new JSDOM();
after(() => dom.window.close());
Object.assign(globalThis, {
	document: dom.window.document,
	DOMParser: dom.window.DOMParser,
	NodeFilter: dom.window.NodeFilter,
});
const message: Message = { id: "a", role: "user", blocks: [] };

test("offscreen Markdown sanitizes custom parsing before trusted decoration and awaits highlighting", async () => {
	const root = await renderMarkdown("formula", {
		message,
		labels: { ...defaultLabels, copyCode: "Copy snippet" },
		highlighter: async (code) => `<span class="highlight">${code}</span>`,
		markdown: {
			async parse(text, source) {
				assert.equal(source, message);
				assert.equal(text, "formula");
				return '<p onclick="bad()"><code class="math">x</code></p><pre><code>x</code></pre><script>bad()</script>';
			},
			async decorate(root, context) {
				assert.equal(root.isConnected, false);
				assert.equal(context.message, message);
				assert.equal(context.streaming, false);
				assert.equal(root.querySelector("[onclick], script"), null);
				assert.equal(root.querySelector(".highlight")?.textContent, "x");
				assert.equal(root.querySelector(".mur-code-copy-btn")?.getAttribute("title"), "Copy snippet");
				const formula = document.createElementNS("http://www.w3.org/1998/Math/MathML", "math");
				formula.textContent = "x";
				await Promise.resolve();
				root.querySelector("code.math")!.replaceWith(formula);
			},
		},
	});
	assert.equal(root.isConnected, false);
	assert.equal(root.querySelector("math")?.textContent, "x");
	assert.equal(root.querySelector(".highlight")?.textContent, "x");
	assert.match(root.textContent!, /<script>bad\(\)<\/script>/);
});

test("failed parsing or partial decoration falls back to readable text without exposing raw HTML", async (t) => {
	const errors = t.mock.method(console, "error", () => {});
	const text = '**answer** <img src="x" onerror="bad()">';
	for (const stage of ["parse", "decorate"] as const) {
		const root = await renderMarkdown(text, {
			message,
			markdown:
				stage === "parse"
					? {
							parse() {
								throw new Error("parse failed");
							},
						}
					: {
							async decorate(root) {
								root.replaceChildren();
								await Promise.resolve();
								throw new Error("decoration failed");
							},
						},
		});
		assert.equal(root.textContent, text);
		assert.equal(root.childElementCount, 0);
	}
	assert.equal(errors.mock.callCount(), 2);
});
