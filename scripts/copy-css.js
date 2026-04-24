import fs from "node:fs";

// Recursively copy from src to dist, filtering only for directories and .css files
fs.cpSync("src", "dist", {
	recursive: true,
	filter: (source) => {
		const isDir = fs.statSync(source).isDirectory();
		return isDir || source.endsWith(".css");
	},
});
console.log("CSS copied successfully!");
