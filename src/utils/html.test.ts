import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM();
const g = global as unknown as Record<string, unknown>;
g.document = dom.window.document;
g.DOMParser = dom.window.DOMParser;
g.NodeFilter = dom.window.NodeFilter;

import { renderSafeHTML } from "./html";

test("keeps safe non-code markdown HTML intact", () => {
	const input = "<p>Hello <strong>World</strong>!</p>";
	const output = document.createElement("div");
	renderSafeHTML(output, input);
	assert.equal(output.innerHTML, input);
});

test("strips unsafe attributes (XSS events, styles, ids)", () => {
	const input = '<p id="hack" style="color:red" onclick="alert(1)" class="test">Text</p>';
	const output = document.createElement("div");
	renderSafeHTML(output, input);
	assert.equal(output.innerHTML, "<p>Text</p>");
});

test("protects against malicious links (javascript:)", () => {
	const input1 = '<a href="https://google.com">Safe</a>';
	const output1 = document.createElement("div");
	renderSafeHTML(output1, input1);
	assert.equal(output1.innerHTML, '<a href="https://google.com">Safe</a>');

	const input2 = '<a href="javascript:alert(1)">Hacked</a>';
	const output2 = document.createElement("div");
	renderSafeHTML(output2, input2);
	assert.equal(output2.innerHTML, "<a>Hacked</a>");
});

test("allows safe link protocols", () => {
	const input = '<a href="http://example.com">HTTP</a><a href="mailto:test@example.com">Mail</a>';
	const output = document.createElement("div");
	renderSafeHTML(output, input);
	assert.equal(output.innerHTML, input);
});

test("allows only safe image sources", () => {
	const input =
		'<img src="https://example.com/a.png" alt="remote"><img src="data:image/png;base64,abc" alt="data"><img src="javascript:alert(1)" alt="bad">';
	const output = document.createElement("div");
	renderSafeHTML(output, input);
	assert.equal(
		output.innerHTML,
		'<img src="https://example.com/a.png" alt="remote"><img src="data:image/png;base64,abc" alt="data"><img alt="bad">',
	);
});

test("escapes unsafe nested tags", () => {
	const input = '<p>Before <span onclick="alert(1)">bad</span> after</p>';
	const output = document.createElement("div");
	renderSafeHTML(output, input);
	assert.equal(output.innerHTML, '<p>Before &lt;span onclick="alert(1)"&gt;bad&lt;/span&gt; after</p>');
});

test("treats highlighter output as trusted for code blocks", () => {
	const input = '<pre><code class="language-ts">const x = 1;</code></pre>';
	const output = document.createElement("div");
	renderSafeHTML(output, input, (code, lang) => `<span class="${lang}">${code}</span>`);
	assert.equal(output.querySelector("pre > code > span.ts")?.textContent, "const x = 1;");
});

test("passes an empty language to highlighter for unlabeled code blocks", () => {
	const input = "<pre><code>const x = 1;</code></pre>";
	const output = document.createElement("div");
	const calls: string[] = [];

	renderSafeHTML(output, input, (code, lang) => {
		calls.push(lang);
		return `<span class="auto">${code}</span>`;
	});

	assert.deepEqual(calls, [""]);
	assert.equal(output.querySelector("pre > code > span.auto")?.textContent, "const x = 1;");
});

test("leaves code block content unchanged when highlighter throws", () => {
	const input = "<pre><code>const x = 1;</code></pre>";
	const output = document.createElement("div");

	renderSafeHTML(output, input, () => {
		throw new Error("Missing grammar");
	});

	assert.equal(output.querySelector("pre > code")?.textContent, "const x = 1;");
});

test("renders language and copy controls for labeled code blocks", () => {
	const input = '<pre><code class="language-ts">const x = 1;</code></pre>';
	const output = document.createElement("div");

	renderSafeHTML(output, input);

	const codeBlock = output.querySelector(".mur-code-block");
	assert.ok(codeBlock);
	assert.equal(codeBlock.querySelector(".mur-code-language")?.textContent, "ts");
	assert.equal(codeBlock.querySelector("button.mur-code-copy-btn")?.getAttribute("type"), "button");
	assert.equal(codeBlock.querySelector("pre > code")?.textContent, "const x = 1;");
});

test("renders code block controls after applying highlighter output", () => {
	const input = '<pre><code class="language-ts">const x = 1;</code></pre>';
	const output = document.createElement("div");

	renderSafeHTML(output, input, (code, lang) => `<span class="${lang}">${code}</span>`);

	assert.equal(output.querySelector(".mur-code-language")?.textContent, "ts");
	assert.equal(output.querySelector("pre > code > span.ts")?.textContent, "const x = 1;");
	assert.ok(output.querySelector("button.mur-code-copy-btn"));
});

test("renders copy-only header for unlabeled code blocks", () => {
	const input = "<pre><code>const x = 1;</code></pre>";
	const output = document.createElement("div");

	renderSafeHTML(output, input);

	assert.ok(output.querySelector(".mur-code-block"));
	assert.equal(output.querySelector(".mur-code-language"), null);
	assert.ok(output.querySelector("button.mur-code-copy-btn"));
});

test("escapes unsafe user markup while adding internal code block controls", () => {
	const input = '<button class="mur-code-copy-btn">Bad</button><pre><code>Safe</code></pre>';
	const output = document.createElement("div");

	renderSafeHTML(output, input);

	assert.ok(output.innerHTML.includes('&lt;button class="mur-code-copy-btn"&gt;Bad&lt;/button&gt;'));
	assert.equal(output.querySelectorAll("button.mur-code-copy-btn").length, 1);
	assert.equal(output.querySelector("pre > code")?.textContent, "Safe");
});

test("escapes dangerous tags to text instead of deleting them (UX)", () => {
	const input = 'Try this: <script>console.log("hack")</script>';
	const output = document.createElement("div");
	renderSafeHTML(output, input);

	assert.ok(!output.innerHTML.includes("<script>"));
	assert.ok(output.innerHTML.includes('&lt;script&gt;console.log("hack")&lt;/script&gt;'));
});
