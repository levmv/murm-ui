import { marked } from "marked";
import type { CodeHighlighter, DeepReadonly, MarkdownOptions, Message } from "./core/types";
import type { ChatLabels } from "./labels";
import { stabilizeMarkdownTail } from "./markdown-tail";
import { renderSafeHTML } from "./utils/html";

export interface MarkdownRenderOptions {
	message: DeepReadonly<Message>;
	markdown?: MarkdownOptions;
	highlighter?: CodeHighlighter;
	labels?: Readonly<ChatLabels>;
	/** Passed to `decorate`; streaming text also gets its unfinished end adjusted. Defaults to false. */
	streaming?: boolean;
}

/** Renders into a detached div using the same pipeline as built-in text blocks. Requires a DOM. */
export async function renderMarkdown(text: string, options: MarkdownRenderOptions): Promise<HTMLElement> {
	const smooth = options.streaming === true && options.markdown?.smoothStreaming !== false;
	try {
		return await renderMarkdownContent(smooth ? stabilizeMarkdownTail(text) : text, options);
	} catch (error) {
		console.error("Failed to render markdown", error);
		// A decorator may have partially changed the tree; plain text is a safe, readable fallback.
		const root = document.createElement("div");
		root.textContent = text;
		return root;
	}
}

/**
 * Parses `source`, such as a streaming tail from `stabilizeMarkdownTail`, and rejects on failure.
 * Internal revision check stops superseded work before starting the next asynchronous stage.
 */
export async function renderMarkdownContent(
	source: string,
	options: MarkdownRenderOptions,
	isCurrent: () => boolean = () => true,
): Promise<HTMLElement> {
	const root = document.createElement("div");
	const parsed = options.markdown?.parse ? options.markdown.parse(source, options.message) : marked.parse(source);
	const html = typeof parsed === "string" ? parsed : await parsed;
	if (!isCurrent()) return root;
	const highlighting = renderSafeHTML(root, html, options.highlighter, options.labels);
	if (highlighting) await highlighting;
	if (!isCurrent()) return root;
	if (options.markdown?.decorate) {
		await options.markdown.decorate(root, { message: options.message, streaming: options.streaming ?? false });
	}
	return root;
}
