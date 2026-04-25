import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const cacheDir = path.join(tmpdir(), "murm-ui-npm-cache");

const result = spawnSync(npmCommand, ["pack", "--dry-run"], {
	env: {
		...process.env,
		npm_config_cache: cacheDir,
	},
	stdio: "inherit",
});

if (result.error) {
	throw result.error;
}

process.exit(result.status ?? 1);
