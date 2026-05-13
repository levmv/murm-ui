import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();

const requiredFiles = [
	"dist/index.js",
	"dist/index.d.ts",
	"dist/with-css.js",
	"dist/with-css.d.ts",
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
	"dist/styles/dropdown.css",
	"dist/styles/feed.css",
	"dist/styles/input.css",
	"dist/styles/sidebar.css",
	"dist/plugins/attachment/attachment-plugin.js",
	"dist/plugins/attachment/attachment-plugin.d.ts",
	"dist/plugins/attachment/attachment.css",
	"dist/plugins/copy/copy-plugin.js",
	"dist/plugins/copy/copy-plugin.d.ts",
	"dist/plugins/edit/edit-plugin.js",
	"dist/plugins/edit/edit-plugin.d.ts",
	"dist/plugins/edit/edit.css",
	"dist/plugins/settings/settings-plugin.js",
	"dist/plugins/settings/settings-plugin.d.ts",
	"dist/plugins/settings/settings.css",
	"dist/plugins/thinking/thinking-plugin.js",
	"dist/plugins/thinking/thinking-plugin.d.ts",
	"dist/plugins/thinking/thinking.css",
	"dist/plugins/tools/tools-plugin.js",
	"dist/plugins/tools/tools-plugin.d.ts",
	"dist/plugins/tools/tools.css",
];

const rootPublicExports = [
	"ChatEngine",
	"ChatUI",
	"IndexedDBStorage",
	"OpenAIProvider",
	"RemoteStorage",
	"RemoteStorageError",
];

const coreCssFiles = [
	"dist/styles/base.css",
	"dist/styles/dropdown.css",
	"dist/styles/feed.css",
	"dist/styles/input.css",
	"dist/styles/sidebar.css",
];

const pluginCssFiles = [
	"dist/plugins/attachment/attachment.css",
	"dist/plugins/edit/edit.css",
	"dist/plugins/settings/settings.css",
	"dist/plugins/thinking/thinking.css",
	"dist/plugins/tools/tools.css",
];

const requiredSideEffects = ["**/*.css", "./dist/with-css.js", "./dist/plugins/*/*-plugin.js"];

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

if (packageJson.exports?.["./with-css"]?.import !== "./dist/with-css.js") {
	throw new Error('package.json export "./with-css" must point to ./dist/with-css.js');
}

if (packageJson.exports?.["./styles/*.css"] !== "./dist/styles/*.css") {
	throw new Error('package.json must export "./styles/*.css"');
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

if (packageJson.exports?.["./plugins/*.css"] !== "./dist/plugins/*.css") {
	throw new Error('package.json must export "./plugins/*.css"');
}

const pluginPatternExport = packageJson.exports?.["./plugins/*"];
if (
	pluginPatternExport?.types !== "./dist/plugins/*/*-plugin.d.ts" ||
	pluginPatternExport?.import !== "./dist/plugins/*/*-plugin.js" ||
	pluginPatternExport?.default !== "./dist/plugins/*/*-plugin.js"
) {
	throw new Error('package.json export "./plugins/*" must point to plugin implementation files');
}

for (const sideEffectPath of requiredSideEffects) {
	if (!packageJson.sideEffects?.includes(sideEffectPath)) {
		throw new Error(`package.json sideEffects must include ${sideEffectPath}`);
	}
}

await Promise.all(requiredFiles.map(assertFile));

function assertInputIncludes(inputs, expectedInput, context) {
	if (!inputs.includes(expectedInput)) {
		throw new Error(`${context} should include ${expectedInput}`);
	}
}

function assertNoInputMatching(inputs, predicate, context) {
	const found = inputs.find(predicate);
	if (found) {
		throw new Error(`${context} should not include ${found}`);
	}
}

function inputPaths(result) {
	return Object.keys(result.metafile.inputs).sort();
}

async function bundleSmoke(contents, sourcefile) {
	return build({
		bundle: true,
		format: "esm",
		logLevel: "silent",
		metafile: true,
		outdir: "package-smoke",
		platform: "browser",
		stdin: {
			contents,
			resolveDir: root,
			sourcefile,
		},
		write: false,
	});
}

await bundleSmoke(
	`
		import { ${rootPublicExports.join(", ")} } from "murm-ui";
		void [${rootPublicExports.join(", ")}];
	`,
	"package-smoke.js",
);

const rootChatBundleInputs = inputPaths(
	await bundleSmoke(
		`
			import { ChatUI } from "murm-ui";
			void ChatUI;
		`,
		"root-chatui-smoke.js",
	),
);
assertNoInputMatching(
	rootChatBundleInputs,
	(input) => input.startsWith("dist/plugins/") || input.endsWith(".css"),
	'root import of "ChatUI"',
);

const withCssBundleInputs = inputPaths(
	await bundleSmoke(
		`
			import { ChatUI } from "murm-ui/with-css";
			void ChatUI;
		`,
		"with-css-smoke.js",
	),
);
for (const cssFile of coreCssFiles) {
	assertInputIncludes(withCssBundleInputs, cssFile, 'import from "murm-ui/with-css"');
}
assertNoInputMatching(withCssBundleInputs, (input) => input.startsWith("dist/plugins/"), 'with-css import of "ChatUI"');

await bundleSmoke(
	`
		import { AttachmentPlugin } from "murm-ui/plugins/attachment";
		import { CopyPlugin } from "murm-ui/plugins/copy";
		import { EditPlugin } from "murm-ui/plugins/edit";
		import { SettingsPlugin } from "murm-ui/plugins/settings";
		import { ThinkingPlugin } from "murm-ui/plugins/thinking";
		import { ToolsPlugin } from "murm-ui/plugins/tools";
		void [AttachmentPlugin, CopyPlugin, EditPlugin, SettingsPlugin, ThinkingPlugin, ToolsPlugin];
	`,
	"plugins-package-smoke.js",
);

const attachmentBundleInputs = inputPaths(
	await bundleSmoke(
		`
			import { AttachmentPlugin } from "murm-ui/plugins/attachment";
			void AttachmentPlugin;
		`,
		"attachment-plugin-smoke.js",
	),
);
assertInputIncludes(
	attachmentBundleInputs,
	"dist/plugins/attachment/attachment.css",
	'import from "murm-ui/plugins/attachment"',
);
for (const cssFile of pluginCssFiles.filter((file) => file !== "dist/plugins/attachment/attachment.css")) {
	assertNoInputMatching(
		attachmentBundleInputs,
		(input) => input === cssFile,
		'import from "murm-ui/plugins/attachment"',
	);
}

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

await import("murm-ui");
await import("murm-ui/highlighter");
await import("murm-ui/highlighter/chat");
await import("murm-ui/highlighter/core");
await import("murm-ui/highlighter/languages");
await import("murm-ui/highlighter/languages/ruby");

console.log("Package smoke passed.");
