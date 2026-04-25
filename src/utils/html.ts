export type Highlighter = (code: string, lang: string) => string;

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
 * Parses a raw HTML string, renders it into the target DOM node,
 * and sanitizes the resulting elements in-place to prevent XSS.
 *
 * @param targetNode - The DOM element that will be mutated/updated.
 * @param rawHtml - The un-sanitized HTML string (usually from marked.parse).
 * @param highlighter - Optional function to apply syntax highlighting to <code> blocks.
 */
export function renderSafeHTML(targetNode: HTMLElement, rawHtml: string, highlighter?: Highlighter): void {
	const doc = getParser().parseFromString(rawHtml, "text/html");
	const walker = document.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);

	const nodesToEscape: Element[] = [];
	const blocksToHighlight: { el: Element; lang: string }[] = [];

	let node = walker.nextNode() as Element;
	while (node) {
		const tagName = node.tagName.toUpperCase();

		if (!ALLOWED_TAGS.has(tagName)) {
			nodesToEscape.push(node);
		} else {
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
					if (highlighter && node.parentElement?.tagName === "PRE") {
						const match = node.getAttribute(attr)?.match(/language-([a-zA-Z0-9+-]+)/);
						if (match) {
							blocksToHighlight.push({ el: node, lang: match[1] });
						}
					}
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
		const highlightedHTML = highlighter!(rawCode, lang);
		if (highlightedHTML) {
			// Note: We inject the highlighted HTML directly without a second sanitization
			// pass for performance reasons during rapid LLM streaming.
			// We operate on the assumption that the provided `highlighter` is
			// trusted and does not inject malicious tags.
			el.innerHTML = highlightedHTML;
		}
	}
	targetNode.innerHTML = "";
	while (doc.body.firstChild) {
		targetNode.appendChild(doc.body.firstChild);
	}
}

// Validates URLs against an explicit whitelist of safe prefixes.
function isSafeUrl(url: string, allowedPrefixes: string[]): boolean {
	const prefix = url.substring(0, 30).trimStart().toLowerCase();

	for (const p of allowedPrefixes) {
		if (prefix.startsWith(p)) return true;
	}

	return false;
}
