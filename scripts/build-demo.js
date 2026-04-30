import { cp, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { build } from "esbuild";

const outfile = "docs/dist/demo/bundle.js";

await mkdir(dirname(outfile), { recursive: true });
await Promise.all([rm(outfile, { force: true }), rm("docs/dist/demo/bundle.css", { force: true })]);
await cp("docs/demo/index.html", "docs/dist/demo/index.html");

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
