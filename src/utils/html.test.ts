import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM();
const g = global as unknown as Record<string, unknown>;
g.document = dom.window.document;
g.DOMParser = dom.window.DOMParser;
g.NodeFilter = dom.window.NodeFilter;

import { renderSafeHTML } from "./html";

test("preserves safe formatting while stripping unsafe attributes", () => {
	const input = '<p id="hack" style="color:red" onclick="alert(1)" class="test">Hello <strong>World</strong>!</p>';
	const output = document.createElement("div");
	renderSafeHTML(output, input);
	assert.equal(output.innerHTML, "<p>Hello <strong>World</strong>!</p>");
});

test("allows web and email links while stripping javascript URLs", () => {
	const safe =
		'<a href="https://example.com">HTTPS</a><a href="http://example.com">HTTP</a><a href="mailto:test@example.com">Mail</a>';
	const output = document.createElement("div");
	renderSafeHTML(output, `${safe}<a href="javascript:alert(1)">Hacked</a>`);
	assert.equal(output.innerHTML, `${safe}<a>Hacked</a>`);
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

test("waits for async highlighting and adds language and copy controls", async () => {
	const input = '<pre><code class="language-ruby">puts "hello"</code></pre>';
	const output = document.createElement("div");

	await renderSafeHTML(output, input, async (code, lang) => `<span class="${lang}">${code}</span>`);

	assert.equal(output.querySelector(".mur-code-language")?.textContent, "ruby");
	assert.equal(output.querySelector("pre > code > span.ruby")?.textContent, 'puts "hello"');
	assert.equal(output.querySelector("button.mur-code-copy-btn")?.getAttribute("type"), "button");
});

test("highlights unlabeled code with an empty language and a copy-only header", () => {
	const input = "<pre><code>const x = 1;</code></pre>";
	const output = document.createElement("div");
	const calls: string[] = [];

	renderSafeHTML(output, input, (code, lang) => {
		calls.push(lang);
		return `<span class="auto">${code}</span>`;
	});

	assert.deepEqual(calls, [""]);
	assert.equal(output.querySelector("pre > code > span.auto")?.textContent, "const x = 1;");
	assert.equal(output.querySelector(".mur-code-language"), null);
	assert.ok(output.querySelector("button.mur-code-copy-btn"));
});

test("leaves code block content unchanged when highlighter throws", () => {
	const input = "<pre><code>const x = 1;</code></pre>";
	const output = document.createElement("div");

	renderSafeHTML(output, input, () => {
		throw new Error("Missing grammar");
	});

	assert.equal(output.querySelector("pre > code")?.textContent, "const x = 1;");
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
