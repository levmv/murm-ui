import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM();
const g = global as unknown as Record<string, unknown>;
g.document = dom.window.document;
g.Node = dom.window.Node;

import { syncDOMChildren } from "../utils/dom";
import { TextFade, unwrapWords } from "./text-fade";

function render(html: string): HTMLElement {
	const root = document.createElement("div");
	root.innerHTML = html;
	return root;
}

/** Words as `text`, with `~` for fading and the delay when set. */
function words(root: Element): string[] {
	return Array.from(root.querySelectorAll(".mur-word"), (span) => {
		const delay = /animation-delay: (\d+)ms/.exec(span.getAttribute("style") ?? "")?.[1];
		return span.classList.contains("mur-fading")
			? `~${span.textContent}${delay ? `@${delay}` : ""}`
			: span.textContent!;
	});
}

test("new words fade in order, and kept spans keep their animation while text grows", () => {
	const fade = new TextFade();
	const live = document.createElement("div");
	const first = render("<p>Hello <strong>wor</strong></p>");
	fade.apply(first, 0);
	assert.deepEqual(words(first), ["~Hello", "~wor@25"]);
	syncDOMChildren(live, first);
	const spans = Array.from(live.querySelectorAll(".mur-word"));

	const second = render("<p>Hello <strong>world</strong> again</p>");
	fade.apply(second, 70);
	assert.deepEqual(words(second), ["~Hello", "~world@25", "~again"]);
	syncDOMChildren(live, second);
	assert.deepEqual(Array.from(live.querySelectorAll(".mur-word")).slice(0, 2), spans);
	assert.equal(live.textContent, "Hello world again");
});

test("finished blocks return to plain text, and their words never fade again", () => {
	const fade = new TextFade();
	fade.apply(render("<p>One two</p>"), 0);
	const later = render("<p>One two</p><p>Three</p>");
	fade.apply(later, 1000);
	assert.equal(later.querySelector("p")!.childNodes.length, 1);
	assert.deepEqual(words(later), ["~Three"]);
	// A block that resumes after its animations ended keeps finished words still.
	const resumed = render("<p>One two</p><p>Three four</p>");
	fade.apply(resumed, 2000);
	assert.deepEqual(words(resumed), ["Three", "~four"]);
});

test("code blocks and unknown markup, such as widgets, are left as they are", () => {
	const root = render(
		'<pre><code>x y</code></pre><p>a <code>b</code> <span class="katex">c</span> <button>d</button></p><ul><li>e</li></ul>',
	);
	new TextFade().apply(root, 0);
	assert.deepEqual(
		words(root).map((word) => word.replace(/@\d+/, "")),
		["~a", "~b", "~e"],
	);
	assert.equal(root.querySelector("pre")!.innerHTML, "<code>x y</code>");
	assert.equal(root.querySelector(".katex")!.innerHTML, "c");
});

test("han and kana fade one character at a time", () => {
	const root = render("<p>你好 world</p>");
	new TextFade().apply(root, 0);
	assert.deepEqual(
		words(root).map((word) => word.replace(/@\d+/, "")),
		["~你", "~好", "~world"],
	);
});

test("long text at the first render counts as already shown", () => {
	const root = render(`<p>${"word ".repeat(30)}</p>`);
	new TextFade().apply(root, 0);
	assert.equal(root.querySelector(".mur-word"), null);
});

test("fast streams compress delays instead of falling behind", () => {
	const fade = new TextFade();
	fade.apply(render("<p>Go</p>"), 0);
	let shown = 1;
	let lastStart = 0;
	for (const [now, count] of [
		[70, 40],
		[140, 120],
	] as const) {
		const root = render(`<p>Go ${"word ".repeat(count)}</p>`);
		fade.apply(root, now);
		// Delays count from when a span is inserted; new words start in order after earlier ones.
		const added = Array.from(root.querySelectorAll(".mur-word")).slice(shown);
		const delays = added.map((span) => Number(/(\d+)ms/.exec(span.getAttribute("style") ?? "")?.[1] ?? 0));
		assert.ok(Math.max(...delays) <= 300, `${now}: ${Math.max(...delays)}`);
		for (const delay of delays) {
			assert.ok(now + delay >= lastStart);
			lastStart = now + delay;
		}
		shown += added.length;
	}
	assert.ok(fade.remaining(140) <= 300 + 200 + 50);
});

test("unwrapping restores plain text nodes", () => {
	const root = render("<p>Hello <em>big</em> world</p>");
	new TextFade().apply(root, 0);
	unwrapWords(root);
	assert.equal(root.innerHTML, "<p>Hello <em>big</em> world</p>");
	assert.equal(root.querySelector("p")!.childNodes.length, 3);
});
