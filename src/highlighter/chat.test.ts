import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { highlight } from "./index";

const TYPESCRIPT_SNIPPET = 'const x: string = "hi";';

test("built-in highlight includes TypeScript syntax tokens", () => {
	const html = highlight(TYPESCRIPT_SNIPPET, "ts");

	assert.match(html, /class="token keyword"/);
	assert.match(html, /class="token builtin"/);
	assert.match(html, /class="token string"/);
});

test("bundled built-in highlight keeps language registration", async () => {
	const source = [
		'import { highlight } from "./src/highlighter/index.ts";',
		`globalThis.__highlighted = highlight(${JSON.stringify(TYPESCRIPT_SNIPPET)}, "ts");`,
	].join("\n");

	const { outputFiles } = await build({
		stdin: {
			contents: source,
			resolveDir: process.cwd(),
			loader: "ts",
		},
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		target: "es2018",
		minify: true,
		treeShaking: true,
	});

	const context = { globalThis: {} as { __highlighted?: string } };
	vm.runInNewContext(outputFiles[0].text, context);

	assert.match(context.globalThis.__highlighted ?? "", /class="token keyword"/);
	assert.match(context.globalThis.__highlighted ?? "", /class="token builtin"/);
	assert.match(context.globalThis.__highlighted ?? "", /class="token string"/);
});
