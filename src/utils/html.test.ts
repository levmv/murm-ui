import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM();
const g = global as unknown as Record<string, unknown>;
g.document = dom.window.document;
g.DOMParser = dom.window.DOMParser;
g.NodeFilter = dom.window.NodeFilter;

import { renderSafeHTML } from "./html";

test("Sanitizer: Keeps safe markdown HTML intact", () => {
	const input = '<p>Hello <strong>World</strong>!</p><pre><code class="language-js">let x = 1;</code></pre>';
	const output = document.createElement("div");
	renderSafeHTML(output, input);
	assert.equal(output.innerHTML, input);
});

test("Sanitizer: Strips unsafe attributes (XSS events, styles, ids)", () => {
	const input = '<p id="hack" style="color:red" onclick="alert(1)" class="test">Text</p>';
	const output = document.createElement("div");
	renderSafeHTML(output, input);
	assert.equal(output.innerHTML, "<p>Text</p>");
});

test("Sanitizer: Protects against malicious links (javascript:)", () => {
	const input1 = '<a href="https://google.com">Safe</a>';
	const output1 = document.createElement("div");
	renderSafeHTML(output1, input1);
	assert.equal(output1.innerHTML, '<a href="https://google.com">Safe</a>');

	const input2 = '<a href="javascript:alert(1)">Hacked</a>';
	const output2 = document.createElement("div");
	renderSafeHTML(output2, input2);
	assert.equal(output2.innerHTML, "<a>Hacked</a>");
});

test("Sanitizer: Escapes dangerous tags to text instead of deleting them (UX)", () => {
	const input = 'Try this: <script>console.log("hack")</script>';
	const output = document.createElement("div");
	renderSafeHTML(output, input);

	assert.ok(!output.innerHTML.includes("<script>"));
	assert.ok(output.innerHTML.includes('&lt;script&gt;console.log("hack")&lt;/script&gt;'));
});
