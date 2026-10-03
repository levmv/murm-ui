import fs from "node:fs";

// Copy styles while preserving the source directory structure.
fs.cpSync("src", "dist", {
	recursive: true,
	filter: (source) => {
		const isDir = fs.statSync(source).isDirectory();
		return isDir || source.endsWith(".css");
	},
});

for (const file of ["THIRD_PARTY_NOTICES.md"]) {
	const source = `src/highlighter/${file}`;
	if (fs.existsSync(source)) {
		fs.cpSync(source, `dist/highlighter/${file}`);
	}
}

console.log("CSS copied successfully!");
