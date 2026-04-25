import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM();
const g = global as unknown as Record<string, unknown>;
g.document = dom.window.document;
g.DOMParser = dom.window.DOMParser;
g.NodeFilter = dom.window.NodeFilter;

import { renderSafeHTML } from "./html";

test("keeps safe markdown HTML intact", () => {
	const input = '<p>Hello <strong>World</strong>!</p><pre><code class="language-js">let x = 1;</code></pre>';
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
	assert.equal(output.innerHTML, '<pre><code class="language-ts"><span class="ts">const x = 1;</span></code></pre>');
});

test("escapes dangerous tags to text instead of deleting them (UX)", () => {
	const input = 'Try this: <script>console.log("hack")</script>';
	const output = document.createElement("div");
	renderSafeHTML(output, input);

	assert.ok(!output.innerHTML.includes("<script>"));
	assert.ok(output.innerHTML.includes('&lt;script&gt;console.log("hack")&lt;/script&gt;'));
});
