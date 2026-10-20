import assert from "node:assert/strict";
import { test } from "node:test";
import { marked } from "marked";
import { INCOMPLETE_LINK_HREF, stabilizeMarkdownTail } from "./markdown-tail";

const link = `(${INCOMPLETE_LINK_HREF})`;

test("unfinished inline syntax closes early or waits; ordinary text is left alone", () => {
	const cases: [string, string][] = [
		["Короче, **гла", "Короче, **гла**"],
		["Короче, **", "Короче, "],
		["use `marked.pa", "use `marked.pa`"],
		["x ~~old", "x ~~old~~"],
		["see [docs", `see [docs]${link}`],
		["**see [docs](htt", `**see [docs]${link}**`],
		["pic ![alt](https://e", "pic "],
		["a <kb", "a "],
		["<a<b", ""],
		// Not emphasis, approximation, currency or unfinished math.
		["snake_case_na", "snake_case_na"],
		["2*3 = 6 and", "2*3 = 6 and"],
		["takes ~2 sec", "takes ~2 sec"],
		["costs $5 and **b", "costs $5 and **b**"],
		["math $x^*", "math $x^*"],
		["[Wiki](https://en.wikipedia.org/wiki/A_(b)) done", "[Wiki](https://en.wikipedia.org/wiki/A_(b)) done"],
		// Escaped markers are text; an unpaired last backslash may escape the next character.
		["Use \\*literal\\*", "Use \\*literal\\*"],
		["path \\\\*", "path \\\\"],
		["a \\", "a "],
		["Use \\! \\< \\[", "Use \\! \\< \\["],
		["Use \\![", "Use \\!"],
		// A reference label is not link text.
		["See [docs][ref]", "See [docs][ref]"],
		["See [docs][re", `See [docs]${link}`],
		["See ![chart][re", "See "],
	];
	for (const [text, expected] of cases) assert.equal(stabilizeMarkdownTail(text), expected, text);
});

test("inline syntax closes across line breaks of the last paragraph only", () => {
	const cases: [string, string][] = [
		["Text **first\n", "Text **first**\n"],
		// Closing goes before a hard line break.
		["Text **first  \nsecond", "Text **first  \nsecond**"],
		["- one **a\n- two", "- one **a\n- two"],
		["Hi!\nsee [1]\n", "Hi!\nsee [1]\n"],
		["Quote **b\n-", "Quote **b**\n"],
	];
	for (const [text, expected] of cases) assert.equal(stabilizeMarkdownTail(text), expected, text);
});

test("ambiguous block starts wait, code and math stay untouched, tables render early", () => {
	const cases: [string, string][] = [
		// A dash after a paragraph would make it a setext heading.
		["Steps:\n-", "Steps:\n"],
		["Text\n1.", "Text\n"],
		["##", ""],
		["- [x", ""],
		["```py", ""],
		["```js\nconst a = 1;\n``", "```js\nconst a = 1;\n"],
		["```js\nconst x = **y", "```js\nconst x = **y"],
		["$$\n\\sum_{i} a*b", "$$\n\\sum_{i} a*b"],
		["> ```js\n> const x = **a", "> ```js\n> const x = **a"],
		// Quote markers inside code are code; fences may open on a list item line.
		["```md\n> ```\nconst x = **a", "```md\n> ```\nconst x = **a"],
		["- ```js\n  const x = **a", "- ```js\n  const x = **a"],
		["- ```js", ""],
		// Indented code, unlike an indented paragraph continuation.
		["Text\n\n    // [TODO", "Text\n\n    // [TODO"],
		["Text\n\n    | A | B |\n", "Text\n\n    | A | B |\n"],
		["1. Step\n\n    Run **b", "1. Step\n\n    Run **b**"],
		["Text\n    more **b", "Text\n    more **b**"],
		// Code stays as is when the next line starts a paragraph or waits as an ambiguous block start.
		["    // [TODO\nNext **b", "    // [TODO\nNext **b**"],
		["    // [TODO\n#", "    // [TODO\n"],
		["    // [TODO\n-", "    // [TODO\n"],
		["- a\n\n      code [x\n-", "- a\n\n      code [x\n"],
		["```js\nconst a = [x\n```\n#", "```js\nconst a = [x\n```\n"],
		["> ```\n> code [x\nText **b", "> ```\n> code [x\nText **b**"],
		["> ```\n#", "> ```\n"],
		["| A | B |\n", "| A | B |\n| --- | --- |"],
		["| A \\| B | C |\n", "| A \\| B | C |\n| --- | --- |"],
		["| A | B |\n|:--", "| A | B |\n| :-- | --- |"],
		["| A | B |\n| --- | --- |\n| `x", "| A | B |\n| --- | --- |\n| `x`"],
		["| A | B |\n| --- | --- |\n|", "| A | B |\n| --- | --- |\n"],
	];
	for (const [text, expected] of cases) assert.equal(stabilizeMarkdownTail(text), expected, text);
});

const replies = [
	`## Как это работает

Короче, **главное** — это *поток* токенов и \`marked.parse()\`. Подробнее в [документации](https://marked.js.org/using_advanced) и на https://example.com/docs.
Вторая строка абзаца с ~~зачёркнутым~~ текстом и snake_case_name без курсива.

Шаги:
- Первый пункт с **жирным**
- Второй пункт
  - вложенный
1. Нумерованный
2. Ещё один, и 2*3 = 6

| Параметр | Значение | Комментарий |
|---|:---:|---|
| \`timeout\` | 70 | мс |
| **retries** | 3 | [ссылка](https://x.dev) |

> Цитата с **акцентом**
> и второй строкой

\`\`\`typescript
const x = await marked.parse(text);
\`\`\`

---

### Итог
Картинка: ![схема](https://example.com/a.png). Конец\\.
`,
	`# Setting up the build

To configure **esbuild** for a *library*, use \`bundle: false\` and keep \`snake_case_names\`. See the [docs](https://esbuild.github.io/api/#build) or [Wikipedia](https://en.wikipedia.org/wiki/Bundle_(software)).

1. Install dependencies:
   \`\`\`bash
   npm install --save-dev esbuild
   \`\`\`
2. Add a script — it takes ~2 seconds and costs $0.
3. Run it with **\`npm run build\`** and check the output.
   - Nested item with _emphasis_ and ~~old text~~

| Option | Default | Description |
| :--- | ---: | --- |
| \`bundle\` | false | Bundle *all* imports |

***

Done! See <https://example.com>.
- [ ] Task
- [x] Done
`,
	`A paragraph with **bold that
continues** on the next line and a [link
over two lines](https://example.com).
A hard break follows  
here.

> Quoted code:
> \`\`\`js
> const x = **a + b**;
> \`\`\`

- Run:
  \`\`\`bash
  echo "**$HOME**"
  \`\`\`
- A fenced item:
  - \`\`\`md
    > \`\`\`
    **not bold**
    \`\`\`

| Expression | Result |
| --- | --- |
| \`a \\| b\` | either |

Indented code:

    const list = [a, **b**];
    // [TODO: *later*
Right after **code**, with \\! and \\<.

    // [FIXME
- A list item right after code

Use \\*literal\\* stars and a \\\\ backslash.
`,
];

const TAGS = /<(h[1-6]|p|ul|ol|li|table|tr|th|td|pre|blockquote|hr|strong|em|del|code|a|img|input)\b/g;

function view(markdown: string) {
	const html = marked.parse(markdown, { async: false });
	return {
		text: html
			.replace(/<[^>]*>/g, "")
			.replace(/&[#\w]+;/g, "&")
			.replace(/\s+/g, " ")
			.trim(),
		tags: Array.from(html.matchAll(TAGS), (match) => match[1]),
	};
}

test("streamed replies never show text or blocks that later disappear", () => {
	for (const reply of replies) {
		const final = view(reply);
		let previous = view("");
		for (let end = 1; end <= reply.length; end++) {
			const shown = view(stabilizeMarkdownTail(reply.slice(0, end)));
			const context = JSON.stringify(reply.slice(Math.max(0, end - 30), end));
			assert.ok(final.text.startsWith(shown.text), `raw syntax shown after ${context}: ${shown.text.slice(-30)}`);
			assert.deepEqual(final.tags.slice(0, shown.tags.length), shown.tags, `block changed after ${context}`);
			// Both frames match the final reply, so the next one only has to be no shorter.
			assert.ok(shown.text.length >= previous.text.length, `text disappeared after ${context}`);
			assert.ok(shown.tags.length >= previous.tags.length, `block disappeared after ${context}`);
			previous = shown;
		}
	}
});

test("long runs of markers, brackets and spaces stay linear", () => {
	const inputs = [
		`x ${"!".repeat(32000)}`,
		"*a ".repeat(7000) + "] ".repeat(7000),
		"[a ".repeat(7000) + " ".repeat(20000),
		"<a".repeat(10000),
		`a${" ".repeat(20000)}b **x`,
		`${"*".repeat(20000)}x`,
		`${"\\".repeat(20000)}*`,
		"*\\".repeat(10000),
		"!\\".repeat(10000),
		"<\\".repeat(10000),
		"- a\n\n    b\n".repeat(5000),
	];
	const start = performance.now();
	for (const text of inputs) stabilizeMarkdownTail(text);
	// Quadratic scans took seconds on these inputs.
	assert.ok(performance.now() - start < 1000);
});
