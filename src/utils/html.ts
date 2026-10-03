import type { CodeHighlighter } from "../core/types";
import { type ChatLabels, defaultLabels } from "../labels";
import { ICON_COPY } from "./icons";

export type Highlighter = CodeHighlighter;

let parser: DOMParser | null = null;

function getParser(): DOMParser {
	parser ??= new DOMParser();
	return parser;
}

// biome-ignore format:.
const ALLOWED_TAGS = new Set([
	"P", "B", "I", "STRONG", "EM", "DEL",
	"A", "BR", "IMG",
	"H1", "H2", "H3", "H4", "H5", "H6",
	"CODE", "BLOCKQUOTE", "PRE", "HR", "UL", "OL", "LI",
	"TABLE", "THEAD", "TBODY", "TR", "TH", "TD",
]);

const SAFE_ATTRS = new Set(["alt", "title", "align", "start"]);
const URL_PREFIXES = ["http://", "https://", "mailto:"];
const IMG_PREFIXES = ["http://", "https://", "data:image/"];

/**
 * Sanitizes HTML and replaces the target's contents, adding code headers and
 * optional highlighting. Resolves after any asynchronous highlighting finishes.
 */
export function renderSafeHTML(
	targetNode: HTMLElement,
	rawHtml: string,
	highlighter?: Highlighter,
	labels: Readonly<ChatLabels> = defaultLabels,
): void | Promise<void> {
	const doc = getParser().parseFromString(rawHtml, "text/html");
	const walker = document.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);

	const nodesToEscape: Element[] = [];
	const blocksToHighlight: { el: Element; lang: string }[] = [];
	const codeElsToDecorate: Element[] = [];
	const pendingHighlights: Promise<void>[] = [];

	let node = walker.nextNode() as Element;
	while (node) {
		const tagName = node.tagName.toUpperCase();

		if (!ALLOWED_TAGS.has(tagName)) {
			nodesToEscape.push(node);
		} else {
			const isCodeBlock = tagName === "CODE" && node.parentElement?.tagName === "PRE";
			const codeLanguage = isCodeBlock ? extractCodeLanguage(node) : null;

			if (isCodeBlock && highlighter) {
				blocksToHighlight.push({ el: node, lang: codeLanguage ?? "" });
			}

			if (isCodeBlock) {
				codeElsToDecorate.push(node);
			}

			const attrs = node.getAttributeNames();
			for (const attr of attrs) {
				const attrLower = attr.toLowerCase();

				if (tagName === "A" && attrLower === "href") {
					const href = node.getAttribute(attr) || "";
					if (!isSafeUrl(href, URL_PREFIXES)) {
						node.removeAttribute(attr);
					}
					continue;
				}

				if (tagName === "IMG" && attrLower === "src") {
					const src = node.getAttribute(attr) || "";
					if (!isSafeUrl(src, IMG_PREFIXES)) {
						node.removeAttribute(attr);
					}
					continue;
				}

				if (tagName === "CODE" && attrLower === "class") {
					continue;
				}

				if (!SAFE_ATTRS.has(attrLower)) {
					node.removeAttribute(attr);
				}
			}
		}
		node = walker.nextNode() as Element;
	}

	for (const el of nodesToEscape) {
		if (!el.parentNode) continue; // Skip if it was already removed by an ancestor
		const textNode = document.createTextNode(el.outerHTML);
		el.replaceWith(textNode);
	}

	for (const { el, lang } of blocksToHighlight) {
		const rawCode = el.textContent || "";
		try {
			const highlightedHTML = highlighter!(rawCode, lang);
			if (isPromiseLike(highlightedHTML)) {
				pendingHighlights.push(
					highlightedHTML
						.then((html) => {
							applyHighlightedHTML(el, html);
						})
						.catch(() => undefined),
				);
				continue;
			}
			applyHighlightedHTML(el, highlightedHTML);
		} catch {}
	}

	const commit = () => {
		decorateCodeBlocks(codeElsToDecorate, labels);

		targetNode.innerHTML = "";
		while (doc.body.firstChild) {
			targetNode.appendChild(doc.body.firstChild);
		}
	};

	if (pendingHighlights.length > 0) {
		return Promise.all(pendingHighlights).then(commit);
	}

	commit();
}

function applyHighlightedHTML(el: Element, highlightedHTML: string): void {
	if (!highlightedHTML) return;

	// The highlighter contract requires trusted HTML with escaped code text.
	el.innerHTML = highlightedHTML;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
	return !!value && typeof value === "object" && "then" in value && typeof value.then === "function";
}

function decorateCodeBlocks(codeEls: Element[], labels: Readonly<ChatLabels>): void {
	for (const codeEl of codeEls) {
		const pre = codeEl.parentElement;
		if (!pre || pre.tagName !== "PRE" || pre.parentElement?.classList.contains("mur-code-block")) continue;

		const language = extractCodeLanguage(codeEl);

		const wrapper = codeEl.ownerDocument.createElement("div");
		wrapper.className = "mur-code-block";

		const header = codeEl.ownerDocument.createElement("div");
		header.className = "mur-code-header";

		if (language !== null) {
			const label = codeEl.ownerDocument.createElement("span");
			label.className = "mur-code-language";
			label.textContent = language;
			header.appendChild(label);
		}

		const button = codeEl.ownerDocument.createElement("button");
		button.className = "mur-code-copy-btn";
		button.type = "button";
		button.title = labels.copyCode;
		button.setAttribute("aria-label", labels.copyCode);
		button.innerHTML = ICON_COPY;
		header.appendChild(button);

		pre.replaceWith(wrapper);
		wrapper.append(header, pre);
	}
}

function extractCodeLanguage(codeEl: Element): string | null {
	const match = codeEl.getAttribute("class")?.match(/(?:^|\s)language-([a-zA-Z0-9+-]+)/);
	return match?.[1] ?? null;
}

function isSafeUrl(url: string, allowedPrefixes: string[]): boolean {
	const prefix = url.substring(0, 30).trimStart().toLowerCase();

	for (const p of allowedPrefixes) {
		if (prefix.startsWith(p)) return true;
	}

	return false;
}
