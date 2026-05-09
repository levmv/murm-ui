import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();

const requiredFiles = [
	"dist/index.js",
	"dist/index.d.ts",
	"dist/highlighter/index.js",
	"dist/highlighter/index.d.ts",
	"dist/highlighter/chat.js",
	"dist/highlighter/chat.d.ts",
	"dist/highlighter/core.js",
	"dist/highlighter/core.d.ts",
	"dist/highlighter/languages/index.js",
	"dist/highlighter/languages/index.d.ts",
	"dist/highlighter/theme.css",
	"dist/highlighter/THIRD_PARTY_NOTICES.md",
	"dist/main.js",
	"dist/main.d.ts",
	"dist/styles/base.css",
	"dist/styles/feed.css",
	"dist/styles/input.css",
	"dist/styles/sidebar.css",
	"dist/plugins/attachment/attachment.css",
	"dist/plugins/edit/edit.css",
	"dist/plugins/settings/settings.css",
	"dist/plugins/thinking/thinking.css",
];

const publicExports = [
	"AttachmentPlugin",
	"ChatUI",
	"CopyPlugin",
	"EditPlugin",
	"IndexedDBStorage",
	"OpenAIProvider",
	"RemoteStorage",
	"SettingsPlugin",
	"ThinkingPlugin",
];

async function assertFile(relativePath) {
	try {
		await access(path.join(root, relativePath));
	} catch {
		throw new Error(`Expected package file is missing: ${relativePath}`);
	}
}

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

if (packageJson.types !== "./dist/index.d.ts") {
	throw new Error('package.json "types" must point to ./dist/index.d.ts');
}

if (packageJson.exports?.["."]?.import !== "./dist/index.js") {
	throw new Error('package.json export "." must point to ./dist/index.js');
}

if (packageJson.exports?.["./styles/*.css"] !== "./dist/styles/*.css") {
	throw new Error('package.json must export "./styles/*.css"');
}

if (packageJson.exports?.["./plugins/*.css"] !== "./dist/plugins/*.css") {
	throw new Error('package.json must export "./plugins/*.css"');
}

if (packageJson.exports?.["./highlighter/*.css"] !== "./dist/highlighter/*.css") {
	throw new Error('package.json must export "./highlighter/*.css"');
}

if (packageJson.exports?.["./highlighter"]?.import !== "./dist/highlighter/index.js") {
	throw new Error('package.json export "./highlighter" must point to ./dist/highlighter/index.js');
}

if (packageJson.exports?.["./highlighter/*"]?.import !== "./dist/highlighter/*.js") {
	throw new Error('package.json export "./highlighter/*" must point to ./dist/highlighter/*.js');
}

await Promise.all(requiredFiles.map(assertFile));

await build({
	bundle: true,
	format: "esm",
	logLevel: "silent",
	outdir: "package-smoke",
	platform: "browser",
	stdin: {
		contents: `
			import { ${publicExports.join(", ")} } from "./dist/index.js";
			void [${publicExports.join(", ")}];
		`,
		resolveDir: root,
		sourcefile: "package-smoke.js",
	},
	write: false,
});

await build({
	bundle: true,
	format: "esm",
	logLevel: "silent",
	outdir: "package-smoke",
	platform: "browser",
	stdin: {
		contents: `
			import { highlight } from "murm-ui/highlighter";
			import { createHighlighter as createChatHighlighter } from "murm-ui/highlighter/chat";
			import { createHighlighter as createCoreHighlighter } from "murm-ui/highlighter/core";
			import { registerBuiltInLanguages } from "murm-ui/highlighter/languages";
			import { registerRubyLanguage } from "murm-ui/highlighter/languages/ruby";
			void [highlight, createChatHighlighter, createCoreHighlighter, registerBuiltInLanguages, registerRubyLanguage];
		`,
		resolveDir: root,
		sourcefile: "highlighter-package-smoke.js",
	},
	write: false,
});

await build({
	bundle: true,
	format: "esm",
	logLevel: "silent",
	outdir: "package-smoke",
	platform: "browser",
	stdin: {
		contents: `
			import "murm-ui/highlighter/theme.css";
		`,
		resolveDir: root,
		sourcefile: "highlighter-css-smoke.js",
	},
	write: false,
});

await import("murm-ui/highlighter");
await import("murm-ui/highlighter/chat");
await import("murm-ui/highlighter/core");
await import("murm-ui/highlighter/languages");
await import("murm-ui/highlighter/languages/ruby");

console.log("Package smoke passed.");
