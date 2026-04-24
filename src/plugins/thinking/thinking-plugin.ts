import "./thinking.css";
import type { ChatPlugin } from "../../core/types";
import { el } from "../../utils/dom";
import { renderSafeHTML } from "../../utils/html";
import { ICON_CHEVRON } from "../../utils/icons";

interface ThinkingState {
	isExpanded: boolean;
	cacheReasoning: string;
	cacheIsGenerating: boolean;
	contentEl: HTMLElement;
	btnSpan: HTMLElement;
	svgIcon: SVGElement;
}

export function ThinkingPlugin(): ChatPlugin {
	const stateMap = new WeakMap<HTMLElement, ThinkingState>();

	return {
		name: "thinking",
		onBlockRender: (block, containerEl, isGenerating) => {
			if (block.type !== "reasoning") return false;

			let state = stateMap.get(containerEl);

			if (!state) {
				const btn = el("button", "think-toggle", {
					innerHTML: ICON_CHEVRON + "<span>Thought Process</span>",
				});

				const btnSpan = btn.querySelector("span") as HTMLElement;
				const svgIcon = btn.querySelector("svg") as SVGElement;

				const contentEl = el("div", "think-content");
				contentEl.style.display = "none";
				const wrapper = el("div", "think-wrapper", {}, [btn, contentEl]);

				containerEl.innerHTML = "";
				containerEl.appendChild(wrapper);

				state = {
					isExpanded: false,
					cacheReasoning: "",
					cacheIsGenerating: false,
					contentEl,
					btnSpan,
					svgIcon,
				};

				btn.onclick = () => {
					state!.isExpanded = !state!.isExpanded;
					contentEl.style.display = state!.isExpanded ? "block" : "none";
					svgIcon.style.transform = `rotate(${state!.isExpanded ? "90deg" : "0deg"})`;

					const displayContent =
						block.text || (block.encrypted ? "<i>Thought process is hidden by the model provider.</i>" : "");

					if (state!.isExpanded && state!.cacheReasoning !== displayContent) {
						renderSafeHTML(contentEl, displayContent);
						state!.cacheReasoning = displayContent;
					}
				};

				stateMap.set(containerEl, state);
			}

			if (state.cacheIsGenerating !== isGenerating) {
				state.btnSpan.textContent = isGenerating ? "Thinking..." : "Thought Process";
				state.cacheIsGenerating = isGenerating;
			}

			const displayContent =
				block.text || (block.encrypted ? "<i>Thought process is hidden by the model provider.</i>" : "");

			if (state.isExpanded && state.cacheReasoning !== displayContent) {
				renderSafeHTML(state.contentEl, displayContent);
				state.cacheReasoning = displayContent;
			}

			return true;
		},
	};
}
