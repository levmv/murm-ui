import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();

const requiredFiles = [
	"dist/index.js",
	"dist/index.d.ts",
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

console.log("Package smoke passed.");
