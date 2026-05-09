import fs from "node:fs";
import path from "node:path";

const distRoot = path.resolve("dist");

rewriteDirectory(distRoot);

function rewriteDirectory(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const entryPath = path.join(dir, entry.name);

		if (entry.isDirectory()) {
			rewriteDirectory(entryPath);
			continue;
		}

		if (entry.isFile() && entry.name.endsWith(".js")) {
			rewriteFile(entryPath);
		}
	}
}

function rewriteFile(filePath) {
	const source = fs.readFileSync(filePath, "utf8");
	const rewritten = source
		.replace(/(\bfrom\s+["'])(\.{1,2}\/[^"']+)(["'])/g, (_match, before, specifier, after) => {
			return `${before}${resolveSpecifier(filePath, specifier)}${after}`;
		})
		.replace(/(\bimport\s+["'])(\.{1,2}\/[^"']+)(["'])/g, (_match, before, specifier, after) => {
			return `${before}${resolveSpecifier(filePath, specifier)}${after}`;
		})
		.replace(/(\bimport\s*\(\s*["'])(\.{1,2}\/[^"']+)(["']\s*\))/g, (_match, before, specifier, after) => {
			return `${before}${resolveSpecifier(filePath, specifier)}${after}`;
		});

	if (rewritten !== source) {
		fs.writeFileSync(filePath, rewritten);
	}
}

function resolveSpecifier(fromFile, specifier) {
	if (path.extname(specifier)) {
		return specifier;
	}

	const absoluteTarget = path.resolve(path.dirname(fromFile), specifier);

	if (fs.existsSync(`${absoluteTarget}.js`)) {
		return `${specifier}.js`;
	}

	if (fs.existsSync(path.join(absoluteTarget, "index.js"))) {
		return `${specifier}/index.js`;
	}

	return specifier;
}
