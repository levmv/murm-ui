import { marked } from "marked";
import type { CodeHighlighter, DeepReadonly, MarkdownOptions, Message } from "./core/types";
import type { ChatLabels } from "./labels";
import { renderSafeHTML } from "./utils/html";

export interface MarkdownRenderOptions {
	message: DeepReadonly<Message>;
	markdown?: MarkdownOptions;
	highlighter?: CodeHighlighter;
	labels?: Readonly<ChatLabels>;
	/** Defaults to false for offscreen rendering. */
	streaming?: boolean;
}

/** Renders into a detached div using the same pipeline as built-in text blocks. Requires a DOM. */
export function renderMarkdown(text: string, options: MarkdownRenderOptions): Promise<HTMLElement> {
	return renderMarkdownContent(text, options);
}

/** Internal revision check stops superseded work before starting the next asynchronous stage. */
export async function renderMarkdownContent(
	text: string,
	options: MarkdownRenderOptions,
	isCurrent: () => boolean = () => true,
): Promise<HTMLElement> {
	const root = document.createElement("div");
	try {
		const parsed = options.markdown?.parse ? options.markdown.parse(text, options.message) : marked.parse(text);
		const html = typeof parsed === "string" ? parsed : await parsed;
		if (!isCurrent()) return root;
		const highlighting = renderSafeHTML(root, html, options.highlighter, options.labels);
		if (highlighting) await highlighting;
		if (!isCurrent()) return root;
		if (options.markdown?.decorate) {
			await options.markdown.decorate(root, { message: options.message, streaming: options.streaming ?? false });
		}
	} catch (error) {
		console.error("Failed to render markdown", error);
		// A decorator may have partially changed the tree. Plain text is a safe,
		// readable fallback without cloning every successful render for rollback.
		root.textContent = text;
	}
	return root;
}
