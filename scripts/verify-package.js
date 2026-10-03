import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import ts from "typescript";

const root = process.cwd();
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const plugins = {
	"agent-thinking": ["AgentThinkingPlugin", "agentThinking"],
	attachment: ["AttachmentPlugin"],
	copy: ["CopyPlugin"],
	edit: ["EditPlugin"],
	settings: ["SettingsPlugin"],
	thinking: ["ThinkingPlugin", "thinking"],
	tools: ["ToolsPlugin", "tools"],
};
const coreCss = ["view", "composer", "base", "dropdown", "feed", "input", "sidebar"].map(
	(name) => `dist/styles/${name}.css`,
);

// Check declared entry files and declarations for the public wildcard entries.
const files = new Set([manifest.types, "dist/highlighter/THIRD_PARTY_NOTICES.md"]);
for (const entry of Object.values(manifest.exports)) {
	for (const target of typeof entry === "string" ? [entry] : Object.values(entry)) {
		if (!target.includes("*")) files.add(target);
	}
}
for (const name of Object.keys(plugins)) files.add(`dist/plugins/${name}/${name}-plugin.d.ts`);
for (const name of ["chat", "core", "languages/ruby"]) files.add(`dist/highlighter/${name}.d.ts`);
await Promise.all([...files].map((file) => access(path.join(root, file))));

// Compile a consumer through package exports, including ESM declaration imports.
const consumerDir = await mkdtemp(path.join(root, ".package-types-"));
try {
	const consumerFile = path.join(consumerDir, "consumer.mts");
	await writeFile(
		consumerFile,
		`import { ChatView, type Message } from "murm-ui";
import { Composer } from "murm-ui/composer";
import { highlight } from "murm-ui/highlighter";
const message: Message = { id: "reply", role: "assistant", blocks: [] };
const view = new ChatView({ container: "#chat", highlighter: highlight });
view.setConversation({ id: "chat", messages: [message] });
new Composer({ container: "#input", onSubmit: command => { console.log(command.text); } });`,
	);
	const program = ts.createProgram([consumerFile], {
		strict: true,
		noEmit: true,
		module: ts.ModuleKind.NodeNext,
		target: ts.ScriptTarget.ES2022,
		types: [],
	});
	const diagnostics = ts.getPreEmitDiagnostics(program);
	assert.equal(
		diagnostics.length,
		0,
		ts.formatDiagnostics(diagnostics, {
			getCanonicalFileName: (file) => file,
			getCurrentDirectory: () => root,
			getNewLine: () => "\n",
		}),
	);
} finally {
	await rm(consumerDir, { recursive: true, force: true });
}

async function bundle(contents) {
	const result = await build({
		bundle: true,
		format: "esm",
		logLevel: "silent",
		metafile: true,
		outdir: "package-smoke",
		platform: "browser",
		stdin: { contents, resolveDir: root, sourcefile: "package-smoke.js" },
		write: false,
	});
	const included = new Set();
	for (const output of Object.values(result.metafile.outputs)) {
		for (const [input, contribution] of Object.entries(output.inputs)) {
			if (contribution.bytesInOutput > 0) included.add(input);
		}
	}
	return included;
}

function exclude(inputs, pattern, context) {
	for (const input of inputs) assert(!pattern.test(input), `${context} includes ${input}`);
}

await bundle(`export {
	ChatEngine, ChatUI, ChatView, Composer, Sidebar, IndexedDBStorage, OpenAIProvider, RemoteStorage, RemoteStorageError
} from "murm-ui";`);

const view = await bundle('export { ChatView, ConversationModel } from "murm-ui/view";');
exclude(
	view,
	/chat-engine|session-manager|components\/composer|plugins\/attachment|core\/providers\/|core\/storage\/|\.css$/,
	"standalone view",
);
const composer = await bundle('export { Composer } from "murm-ui/composer";');
exclude(
	composer,
	/marked|chat-engine|session-manager|components\/feed|plugins\/attachment|view\/chat-view|core\/providers\/|core\/storage\/|\.css$/,
	"standalone composer",
);
const sidebar = await bundle('export { Sidebar } from "murm-ui/sidebar";');
exclude(
	sidebar,
	/marked|chat-engine|session-manager|components\/feed|view\/|core\/providers\/|core\/storage\/|\.css$/,
	"standalone sidebar",
);
assert(
	[...view].some((input) => input.includes("node_modules/marked/")),
	"The view must include built-in Markdown support",
);

const chat = await bundle('export { ChatUI } from "murm-ui";');
exclude(chat, /^dist\/plugins\/|\.css$/, "root ChatUI import");
const withCss = await bundle('export { ChatUI, ChatView, Composer } from "murm-ui/with-css";');
for (const file of coreCss) assert(withCss.has(file), `with-css is missing ${file}`);
exclude(withCss, /^dist\/plugins\//, "with-css import");

await bundle(
	Object.entries(plugins)
		.map(([name, exports]) => `export { ${exports.join(", ")} } from "murm-ui/plugins/${name}";`)
		.join("\n"),
);
const attachment = await bundle('export { AttachmentPlugin } from "murm-ui/plugins/attachment";');
assert(attachment.has("dist/plugins/attachment/attachment.css"), "AttachmentPlugin must include its CSS");
exclude(attachment, /^dist\/plugins\/(?!attachment\/)/, "AttachmentPlugin import");

await bundle(`
	export { highlight } from "murm-ui/highlighter";
	export { createHighlighter as createChatHighlighter } from "murm-ui/highlighter/chat";
	export { createHighlighter as createCoreHighlighter } from "murm-ui/highlighter/core";
	export { registerBuiltInLanguages } from "murm-ui/highlighter/languages";
	export { registerRubyLanguage } from "murm-ui/highlighter/languages/ruby";
	import "murm-ui/highlighter/theme.css";
	import "murm-ui/styles/view.css";
	import "murm-ui/plugins/tools/tools.css";
`);

// These entries must also load in Node, without CSS loaders or browser globals.
for (const entry of [
	"murm-ui",
	"murm-ui/view",
	"murm-ui/composer",
	"murm-ui/sidebar",
	"murm-ui/highlighter",
	"murm-ui/highlighter/chat",
	"murm-ui/highlighter/core",
	"murm-ui/highlighter/languages",
	"murm-ui/highlighter/languages/ruby",
])
	await import(entry);

console.log("Package smoke passed.");
