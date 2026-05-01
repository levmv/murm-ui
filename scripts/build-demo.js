import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { build } from "esbuild";

const outfile = "docs/dist/demo/bundle.js";
const assetVersion = process.env.GITHUB_SHA ?? String(Date.now());

await mkdir(dirname(outfile), { recursive: true });
await Promise.all([rm(outfile, { force: true }), rm("docs/dist/demo/bundle.css", { force: true })]);
await cp("docs/demo/index.html", "docs/dist/demo/index.html");
await bustDemoAssetCache();

console.log("Bundling demo assets...");

await build({
	entryPoints: ["docs/demo/app.ts"],
	bundle: true,
	outfile,
	minify: true,
	target: "es2018",
	logLevel: "info",
});

console.log("Demo build complete!");

async function bustDemoAssetCache() {
	const indexPath = "docs/dist/demo/index.html";
	const html = await readFile(indexPath, "utf8");
	await writeFile(
		indexPath,
		html
			.replace('href="bundle.css"', `href="bundle.css?v=${assetVersion}"`)
			.replace('src="bundle.js"', `src="bundle.js?v=${assetVersion}"`),
	);
}
