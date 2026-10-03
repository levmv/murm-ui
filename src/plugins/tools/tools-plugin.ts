import "./tools.css";
import type { ContentBlock, Message, MessagePlugin, RendererContext } from "../../core/types";
import { type ChatLabels, defaultLabels } from "../../labels";
import { el } from "../../utils/dom";
import { ICON_CHEVRON } from "../../utils/icons";

type ToolCallBlock = Extract<ContentBlock, { type: "tool_call" }>;
type ToolResultBlock = Extract<ContentBlock, { type: "tool_result" }>;

export interface ToolRenderContext {
	labels: Readonly<ChatLabels>;
	toolCall: ToolCallBlock;
	toolResult?: ToolResultBlock;
	message: Message;
	messages: readonly Message[];
	blockIndex: number;
	isGenerating: boolean;
	args: unknown;
	argsText: string;
	result: unknown;
	outputText: string;
}

export interface ToolRenderer {
	label?: string | ((ctx: ToolRenderContext) => string | undefined);
	preview?: (ctx: ToolRenderContext) => string | undefined;
	formatArgs?: (ctx: ToolRenderContext) => string | undefined;
	formatResult?: (ctx: ToolRenderContext) => string | undefined;
}

export interface ToolsPluginConfig {
	/** Hide raw arguments/results; application labels and summaries remain visible. */
	details?: boolean;
	defaultExpanded?: boolean | ((ctx: ToolRenderContext) => boolean);
	maxLabelChars?: number;
	maxPreviewChars?: number;
	tools?: Record<string, ToolRenderer>;
}

interface ToolState {
	labels: Readonly<ChatLabels>;
	expanded: boolean;
	detailsEnabled: boolean;
	rootEl: HTMLElement;
	ctx?: ToolRenderContext;
	renderer?: ToolRenderer;
	previewText: string;
	buttonEl: HTMLButtonElement;
	titleEl: HTMLElement;
	statusEl: HTMLElement;
	previewEl?: HTMLElement;
	detailsEl?: HTMLElement;
	details?: ToolDetailsState;
}

interface ToolDetailsState {
	argsPre: HTMLPreElement;
	resultTitleEl: HTMLElement;
	resultPre: HTMLPreElement;
}

interface ToolResultIndex {
	positions: Map<string, number>;
	results: Map<string, { position: number; block: ToolResultBlock }[]>;
}

const DEFAULT_MAX_LABEL_CHARS = 120;
const DEFAULT_MAX_PREVIEW_CHARS = 240;
const MAX_ARG_SUMMARY_VALUE_CHARS = 40;

/** Lifecycle renderer for detailed or summarized tool calls. */
export function tools(config: ToolsPluginConfig = {}): MessagePlugin {
	const indexes = new WeakMap<readonly Message[], ToolResultIndex>();
	return {
		name: "tools",
		renderers: [
			{
				matches: (block) => block.type === "tool_call",
				mount(container) {
					let state: ToolState | undefined;
					return {
						update(block, context) {
							if (block.type !== "tool_call") return;
							let index = indexes.get(context.messages);
							if (!index) {
								index = indexToolResults(context.messages);
								indexes.set(context.messages, index);
							}
							const position = index.positions.get(context.message.id) ?? 0;
							const result = index.results.get(block.toolCallId)?.find((entry) => entry.position >= position)?.block;
							const ctx = createToolContext(block, context, result);
							if (!state) {
								state = createToolState(container, resolveDefaultExpanded(config.defaultExpanded, ctx), ctx.labels);
								container.replaceChildren(state.buttonEl);
								state.buttonEl.onclick = () => {
									state!.expanded = !state!.expanded;
									syncExpansion(state!);
								};
							}
							renderTool(state, ctx, config);
						},
						destroy() {
							if (state) state.buttonEl.onclick = null;
							state = undefined;
						},
					};
				},
			},
		],
	};
}

export { tools as ToolsPlugin };

function createToolState(rootEl: HTMLElement, expanded: boolean, labels: Readonly<ChatLabels>): ToolState {
	const chevronEl = el("span", "mur-tool-chevron", { innerHTML: ICON_CHEVRON });
	const titleEl = el("span", "mur-tool-title");
	const statusEl = el("span", "mur-tool-status");
	const buttonEl = el("button", "mur-tool-summary", { type: "button" }, [statusEl, titleEl, chevronEl]);

	const state = {
		labels,
		expanded,
		detailsEnabled: true,
		rootEl,
		previewText: "",
		buttonEl,
		titleEl,
		statusEl,
	};

	syncExpansion(state);
	return state;
}

function renderTool(state: ToolState, ctx: ToolRenderContext, config: ToolsPluginConfig): void {
	const container = state.rootEl;
	const renderer = config.tools?.[ctx.toolCall.name];
	const status = ctx.toolResult?.isError ? "error" : ctx.toolCall.status;
	state.detailsEnabled = config.details !== false;
	const className = `mur-content-block mur-block-tool_call mur-tool mur-tool-${status}${state.detailsEnabled ? "" : " mur-tool-summary-only"}`;
	if (container.className !== className) container.className = className;
	if (!state.detailsEnabled) state.expanded = false;
	const label =
		rendererLabel(renderer, ctx) ??
		ctx.toolCall.summary ??
		(state.detailsEnabled ? defaultToolLabel(ctx.toolCall, ctx.args) : ctx.toolCall.name);
	const preview = renderer?.preview?.(ctx) ?? (state.detailsEnabled ? defaultPreview(ctx) : undefined);
	const statusText = ctx.labels.toolStatus(status);

	state.labels = ctx.labels;
	state.ctx = ctx;
	state.renderer = renderer;
	setText(state.titleEl, truncateText(label, config.maxLabelChars ?? DEFAULT_MAX_LABEL_CHARS));
	setText(state.statusEl, statusSymbol(status));
	setAttribute(state.statusEl, "title", statusText);
	setAttribute(state.statusEl, "aria-label", statusText);
	setAttribute(state.buttonEl, "aria-label", `${label} (${statusText})`);

	state.previewText = truncateText(preview ?? "", config.maxPreviewChars ?? DEFAULT_MAX_PREVIEW_CHARS);

	syncExpansion(state);
}

function createToolContext(
	toolCall: ToolCallBlock,
	ctx: RendererContext,
	toolResult: ToolResultBlock | undefined,
): ToolRenderContext {
	const messages = ctx.messages;
	let argsParsed = false;
	let parsedArgs: unknown;
	const outputText = toolResult?.outputText ?? "";
	let resultParsed = false;
	let parsedResult: unknown;

	return {
		labels: ctx.labels ?? defaultLabels,
		toolCall,
		toolResult,
		message: ctx.message,
		messages,
		blockIndex: ctx.blockIndex,
		isGenerating: ctx.isGenerating,
		get args() {
			if (!argsParsed) {
				parsedArgs = parseJson(toolCall.argsText);
				argsParsed = true;
			}
			return parsedArgs;
		},
		argsText: toolCall.argsText,
		outputText,
		get result() {
			if (!resultParsed) {
				parsedResult = parseJson(outputText);
				resultParsed = true;
			}
			return parsedResult;
		},
	};
}

function indexToolResults(messages: readonly Message[]): ToolResultIndex {
	// Structural updates replace the transcript array. All cards share one scan
	// per revision; WeakMap keys let old transcripts go with their views.
	const index: ToolResultIndex = { positions: new Map(), results: new Map() };
	messages.forEach((message, position) => {
		index.positions.set(message.id, position);
		for (const block of message.blocks) {
			if (block.type !== "tool_result") continue;
			let results = index.results.get(block.toolCallId);
			if (!results) {
				results = [];
				index.results.set(block.toolCallId, results);
			}
			results.push({ position, block });
		}
	});
	return index;
}

function rendererLabel(renderer: ToolRenderer | undefined, ctx: ToolRenderContext): string | undefined {
	if (!renderer?.label) return undefined;
	return typeof renderer.label === "function" ? renderer.label(ctx) : renderer.label;
}

function resolveDefaultExpanded(
	defaultExpanded: ToolsPluginConfig["defaultExpanded"],
	ctx: ToolRenderContext,
): boolean {
	if (typeof defaultExpanded === "function") return defaultExpanded(ctx);
	return defaultExpanded ?? false;
}

function syncExpansion(state: ToolState): void {
	if (state.buttonEl.disabled !== !state.detailsEnabled) state.buttonEl.disabled = !state.detailsEnabled;
	if (!state.detailsEnabled) state.expanded = false;
	setAttribute(state.buttonEl, "aria-expanded", String(state.expanded));
	syncPreview(state);

	if (state.expanded && state.ctx) {
		renderDetails(state);
		return;
	}

	clearDetails(state);
}

function renderDetails(state: ToolState): void {
	const ctx = state.ctx;
	if (!ctx) return;
	const details = ensureDetails(state);
	setText(details.argsPre, state.renderer?.formatArgs?.(ctx) ?? defaultArgsText(ctx));
	setText(details.resultTitleEl, ctx.toolResult?.isError ? state.labels.toolError : state.labels.toolResult);
	setText(details.resultPre, state.renderer?.formatResult?.(ctx) ?? defaultResultText(ctx));
}

function clearDetails(state: ToolState): void {
	if (state.detailsEl) {
		state.detailsEl.remove();
		state.detailsEl = undefined;
	}
	state.details = undefined;
}

function ensureDetails(state: ToolState): ToolDetailsState {
	if (state.details) return state.details;

	const argsTitleEl = el("div", "mur-tool-section-title", { textContent: state.labels.toolArguments });
	const argsPre = el("pre", "mur-tool-pre");
	const argsSectionEl = el("section", "mur-tool-section", {}, [argsTitleEl, argsPre]);

	const resultTitleEl = el("div", "mur-tool-section-title", { textContent: state.labels.toolResult });
	const resultPre = el("pre", "mur-tool-pre");
	const resultSectionEl = el("section", "mur-tool-section", {}, [resultTitleEl, resultPre]);

	ensureDetailsEl(state).replaceChildren(argsSectionEl, resultSectionEl);
	state.details = {
		argsPre,
		resultTitleEl,
		resultPre,
	};
	return state.details;
}

function syncPreview(state: ToolState): void {
	if (!state.previewText || state.expanded) {
		state.previewEl?.remove();
		state.previewEl = undefined;
		return;
	}

	const previewEl = ensurePreviewEl(state);
	setText(previewEl, state.previewText);
}

function setText(element: HTMLElement, text: string): void {
	if (element.textContent !== text) element.textContent = text;
}

function setAttribute(element: HTMLElement, name: string, value: string): void {
	if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function ensurePreviewEl(state: ToolState): HTMLElement {
	if (state.previewEl) return state.previewEl;

	const previewEl = el("div", "mur-tool-preview");
	state.rootEl.insertBefore(previewEl, state.detailsEl ?? null);
	state.previewEl = previewEl;
	return previewEl;
}

function ensureDetailsEl(state: ToolState): HTMLElement {
	if (state.detailsEl) return state.detailsEl;

	const detailsEl = el("div", "mur-tool-details");
	state.rootEl.appendChild(detailsEl);
	state.detailsEl = detailsEl;
	return detailsEl;
}

function defaultToolLabel(toolCall: ToolCallBlock, args: unknown): string {
	const name = toolCall.name || "tool";
	const summary = summarizeArgs(args, toolCall.argsText);
	return summary ? `${name} ${summary}` : name;
}

function summarizeArgs(args: unknown, argsText: string): string {
	if (args && typeof args === "object" && !Array.isArray(args)) {
		const entries = Object.entries(args as Record<string, unknown>).filter(
			([, value]) => value !== undefined && value !== null,
		);
		if (entries.length === 0) return "";

		const preferred = [
			"command",
			"cmd",
			"pattern",
			"query",
			"path",
			"dir_path",
			"file",
			"filePath",
			"filepath",
			"url",
			"name",
		];
		const preferredEntries: Array<[string, unknown]> = [];
		for (const key of preferred) {
			const match = entries.find(([entryKey]) => entryKey === key);
			if (match) preferredEntries.push(match);
			if (preferredEntries.length >= 2) break;
		}

		const summaryEntries = preferredEntries.length > 0 ? preferredEntries : entries.slice(0, 2);
		if (summaryEntries.length > 0) {
			if (summaryEntries.length === 1 && preferredEntries.length === 1) {
				return compactValue(summaryEntries[0][1]);
			}
			return summaryEntries.map(([key, value]) => `${key}=${compactValue(value)}`).join(" ");
		}

		return `${entries.length} args`;
	}

	if (Array.isArray(args)) return `${args.length} items`;
	if (args !== undefined) return compactValue(args);

	const raw = argsText.trim().replace(/\s+/g, " ");
	return raw === "{}" ? "" : raw;
}

function compactValue(value: unknown): string {
	const text =
		typeof value === "string"
			? value
			: typeof value === "number" || typeof value === "boolean" || value === null
				? String(value)
				: JSON.stringify(value);
	return truncateText(text.replace(/\s+/g, " "), MAX_ARG_SUMMARY_VALUE_CHARS);
}

function defaultPreview(ctx: ToolRenderContext): string | undefined {
	if (!ctx.toolResult?.isError) return undefined;
	return ctx.outputText || ctx.labels.toolFailed;
}

function defaultArgsText(ctx: ToolRenderContext): string {
	if (ctx.args !== undefined) return JSON.stringify(ctx.args, null, 2);
	return ctx.argsText.trim() || "{}";
}

function defaultResultText(ctx: ToolRenderContext): string {
	if (!ctx.toolResult) {
		if (ctx.toolCall.status === "running") return ctx.labels.toolRunning;
		if (ctx.toolCall.status === "pending") return ctx.labels.toolWaiting;
		return ctx.labels.toolNoResult;
	}

	if (ctx.result !== undefined) return JSON.stringify(ctx.result, null, 2);
	return ctx.outputText;
}

function parseJson(text: string): unknown {
	const firstChar = firstNonWhitespaceChar(text);
	if (!firstChar || !'{["-0123456789tfn'.includes(firstChar)) return undefined;

	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function firstNonWhitespaceChar(text: string): string {
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char !== " " && char !== "\n" && char !== "\r" && char !== "\t") return char;
	}
	return "";
}

function statusSymbol(status: ToolCallBlock["status"] | "error"): string {
	switch (status) {
		case "complete":
			return "✓";
		case "error":
			return "×";
		default:
			return "...";
	}
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 3) return text.slice(0, maxChars);
	return `${text.slice(0, maxChars - 3)}...`;
}
