import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { marked } from "marked";

const outDir = "docs/dist";

const pages = [{ source: "docs/guide.md", output: "guide.html", title: "Documentation" }];

const navItems = [
	["Home", "./"],
	["Docs", "guide.html"],
	["Demo", "demo/"],
	["GitHub", "https://github.com/levmv/murm-ui"],
];

function escapeHtml(value) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function renderNav(currentHref) {
	return navItems
		.map(([label, href]) => {
			const ariaCurrent = href === currentHref ? ' aria-current="page"' : "";
			return `<a href="${href}"${ariaCurrent}>${label}</a>`;
		})
		.join("\n");
}

function renderPage({ title, body, currentHref }) {
	return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>${escapeHtml(title)} - Murm UI</title>
		<meta name="description" content="Murm UI documentation for ${escapeHtml(title.toLowerCase())}." />
		<style>
			:root {
				color-scheme: light;
				--bg: #fbfaf8;
				--panel: #ffffff;
				--text: #171717;
				--muted: #5f6368;
				--line: #dedbd4;
				--accent: #0f766e;
				--accent-strong: #0b4f49;
				--code-bg: #f3f1eb;
				font-family:
					Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			}

			* {
				box-sizing: border-box;
			}

			body {
				background: var(--bg);
				color: var(--text);
				margin: 0;
			}

			a {
				color: var(--accent-strong);
				font-weight: 650;
				text-decoration-thickness: 0.08em;
				text-underline-offset: 0.18em;
			}

			.site-header {
				background: rgba(251, 250, 248, 0.92);
				border-bottom: 1px solid var(--line);
				position: sticky;
				top: 0;
				z-index: 2;
			}

			.nav {
				align-items: center;
				display: flex;
				gap: 18px;
				justify-content: space-between;
				margin: 0 auto;
				max-width: 1060px;
				padding: 14px 22px;
			}

			.brand {
				align-items: center;
				color: var(--text);
				display: inline-flex;
				gap: 10px;
				text-decoration: none;
			}

			.brand-mark {
				align-items: center;
				background: var(--text);
				border-radius: 5px;
				color: #fff;
				display: inline-flex;
				font-size: 0.85rem;
				font-weight: 800;
				height: 28px;
				justify-content: center;
				width: 28px;
			}

			.nav-links {
				align-items: center;
				display: flex;
				flex-wrap: wrap;
				gap: 14px;
			}

			.nav-links a {
				color: var(--muted);
				font-size: 0.94rem;
				text-decoration: none;
			}

			.nav-links a[aria-current="page"] {
				color: var(--text);
			}

			main {
				margin: 0 auto;
				max-width: 860px;
				padding: 48px 22px 72px;
			}

			.doc {
				background: var(--panel);
				border: 1px solid var(--line);
				border-radius: 8px;
				padding: clamp(22px, 5vw, 46px);
			}

			h1,
			h2,
			h3 {
				letter-spacing: 0;
				line-height: 1.12;
			}

			h1 {
				font-size: clamp(2.2rem, 6vw, 4.2rem);
				margin: 0 0 18px;
			}

			h2 {
				border-top: 1px solid var(--line);
				font-size: 1.65rem;
				margin: 42px 0 14px;
				padding-top: 32px;
			}

			h3 {
				font-size: 1.15rem;
				margin: 26px 0 10px;
			}

			p,
			li {
				color: var(--muted);
				font-size: 1rem;
				line-height: 1.7;
			}

			pre {
				background: var(--code-bg);
				border: 1px solid var(--line);
				border-radius: 8px;
				overflow-x: auto;
				padding: 18px;
			}

			code {
				font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
				font-size: 0.92rem;
			}

			p code,
			li code {
				background: var(--code-bg);
				border: 1px solid var(--line);
				border-radius: 5px;
				color: var(--text);
				padding: 0.08rem 0.28rem;
			}

			@media (max-width: 760px) {
				.nav {
					align-items: flex-start;
					flex-direction: column;
				}
			}
		</style>
	</head>
	<body>
		<header class="site-header">
			<nav class="nav" aria-label="Main navigation">
				<a class="brand" href="./">
					<span class="brand-mark">M</span>
					<strong>Murm UI</strong>
				</a>
				<div class="nav-links">
					${renderNav(currentHref)}
				</div>
			</nav>
		</header>

		<main>
			<article class="doc">
				${body}
			</article>
		</main>
	</body>
</html>
`;
}

await rm(outDir, { recursive: true, force: true });
await mkdir(`${outDir}/demo`, { recursive: true });
await cp("docs/index.html", `${outDir}/index.html`);
await cp("docs/demo/index.html", `${outDir}/demo/index.html`);

for (const page of pages) {
	const markdown = await readFile(page.source, "utf8");
	const body = marked.parse(markdown, { async: false });
	await writeFile(`${outDir}/${page.output}`, renderPage({ title: page.title, body, currentHref: page.output }));
}

console.log("Docs build complete!");
