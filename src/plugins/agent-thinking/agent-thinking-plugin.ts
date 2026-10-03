import "./agent-thinking.css";
import type { MessagePlugin } from "../../core/types";
import { type ChatLabels, defaultLabels } from "../../labels";
import { el } from "../../utils/dom";

export interface AgentThinkingPluginConfig {
	previewLines?: number;
}

interface AgentThinkingState {
	labels: Readonly<ChatLabels>;
	destroyed: boolean;
	renderedExpanded?: boolean;
	renderedExpandable?: boolean;
	expanded: boolean;
	expandable: boolean;
	explicitExpandable: boolean;
	contentCache: string;
	measureFrame: number | null;
	previewEl: HTMLElement;
	textEl: HTMLElement;
}

const DEFAULT_PREVIEW_LINES = 3;

/** Inline reasoning preview with an expandable body. */
export function agentThinking(config: AgentThinkingPluginConfig = {}): MessagePlugin {
	const previewLines = Math.max(1, Math.floor(config.previewLines ?? DEFAULT_PREVIEW_LINES));
	return {
		name: "agentThinking",
		renderers: [
			{
				matches: (block) => block.type === "reasoning" && (block.encrypted === true || block.text.trim().length > 0),
				mount(container) {
					const state = createState(previewLines);
					container.className = "mur-content-block mur-block-reasoning mur-agent-think";
					container.replaceChildren(state.previewEl);
					return {
						update(block, context) {
							if (block.type !== "reasoning") return;
							state.labels = context.labels ?? defaultLabels;
							const content = block.encrypted ? state.labels.hiddenReasoning : block.text;
							if (state.contentCache === content) return;
							state.textEl.textContent = content;
							state.contentCache = content;
							state.explicitExpandable = countExplicitLines(content) > previewLines;
							if (state.explicitExpandable) {
								state.expandable = true;
								syncState(state);
							} else if (!state.expanded) queueMeasure(state);
						},
						destroy() {
							state.destroyed = true;
							state.previewEl.onclick = null;
							state.previewEl.onkeydown = null;
							const win = state.previewEl.ownerDocument.defaultView;
							if (state.measureFrame !== null) {
								if (win?.cancelAnimationFrame) win.cancelAnimationFrame(state.measureFrame);
								else if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(state.measureFrame);
							}
						},
					};
				},
			},
		],
	};
}

export { agentThinking as AgentThinkingPlugin };

function createState(previewLines: number): AgentThinkingState {
	const textEl = el("span", "mur-agent-think-text");
	const previewEl = el("div", "mur-agent-think-preview", null, [textEl]);
	previewEl.style.setProperty("--mur-agent-think-preview-lines", String(previewLines));

	const state: AgentThinkingState = {
		labels: defaultLabels,
		destroyed: false,
		expanded: false,
		expandable: false,
		explicitExpandable: false,
		contentCache: "",
		measureFrame: null,
		previewEl,
		textEl,
	};

	previewEl.onclick = () => toggleExpanded(state);
	previewEl.onkeydown = (event) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		if (!state.expandable) return;
		event.preventDefault();
		toggleExpanded(state);
	};

	syncState(state);
	return state;
}

function toggleExpanded(state: AgentThinkingState): void {
	if (!state.expandable) return;
	state.expanded = !state.expanded;
	syncState(state);
	if (!state.expanded && !state.explicitExpandable) queueMeasure(state);
}

function syncState(state: AgentThinkingState): void {
	if (!state.expandable) state.expanded = false;
	if (state.renderedExpanded === state.expanded && state.renderedExpandable === state.expandable) return;
	state.renderedExpanded = state.expanded;
	state.renderedExpandable = state.expandable;

	state.previewEl.dataset.expandable = String(state.expandable);
	state.previewEl.dataset.expanded = String(state.expanded);

	if (state.expandable) {
		state.previewEl.setAttribute("role", "button");
		state.previewEl.tabIndex = 0;
		state.previewEl.setAttribute("aria-expanded", String(state.expanded));
		state.previewEl.setAttribute("aria-label", state.labels.toggleReasoning);
		return;
	}

	state.previewEl.removeAttribute("role");
	state.previewEl.removeAttribute("tabindex");
	state.previewEl.removeAttribute("aria-expanded");
	state.previewEl.removeAttribute("aria-label");
}

function queueMeasure(state: AgentThinkingState): void {
	if (state.measureFrame !== null) return;
	const win = state.previewEl.ownerDocument.defaultView;
	const requestFrame =
		win?.requestAnimationFrame?.bind(win) ??
		(typeof requestAnimationFrame === "function" ? requestAnimationFrame : undefined);

	if (!requestFrame) {
		measureExpandable(state);
		return;
	}

	state.measureFrame = requestFrame(() => {
		state.measureFrame = null;
		measureExpandable(state);
	});
}

function measureExpandable(state: AgentThinkingState): void {
	if (state.destroyed || state.expanded || state.explicitExpandable) return;

	const measuredExpandable = state.textEl.scrollHeight > state.textEl.clientHeight + 1;
	if (state.expandable === measuredExpandable) return;

	state.expandable = measuredExpandable;
	syncState(state);
}

function countExplicitLines(text: string): number {
	return text.split(/\r\n|\r|\n/).length;
}
