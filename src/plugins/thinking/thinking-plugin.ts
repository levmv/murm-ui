import "./thinking.css";
import type { MessagePlugin } from "../../core/types";
import { defaultLabels } from "../../labels";
import { el } from "../../utils/dom";
import { renderSafeHTML } from "../../utils/html";
import { ICON_CHEVRON } from "../../utils/icons";

/** Collapsible reasoning; content is rendered only when opened. */
export function thinking(): MessagePlugin {
	return {
		name: "thinking",
		renderers: [
			{
				matches: (block) => block.type === "reasoning",
				mount(container) {
					const button = el("button", "mur-think-toggle", { type: "button", innerHTML: ICON_CHEVRON });
					const label = el("span");
					button.appendChild(label);
					button.setAttribute("aria-expanded", "false");
					const contentEl = el("div", "mur-think-content", { hidden: true });
					container.replaceChildren(el("div", "mur-think-wrapper", null, [button, contentEl]));
					let expanded = false;
					let content = "";
					let encrypted = false;
					let labels = defaultLabels;
					let rendered: string | undefined;
					let renderedEncrypted = false;
					const render = () => {
						if (!expanded || (rendered === content && renderedEncrypted === encrypted)) return;
						if (encrypted) contentEl.replaceChildren(el("i", "", { textContent: content }));
						else renderSafeHTML(contentEl, content, undefined, labels);
						rendered = content;
						renderedEncrypted = encrypted;
					};
					button.onclick = () => {
						expanded = !expanded;
						contentEl.hidden = !expanded;
						button.setAttribute("aria-expanded", String(expanded));
						render();
					};
					return {
						update(block, ctx) {
							if (block.type !== "reasoning") return;
							labels = ctx.labels ?? defaultLabels;
							encrypted = block.encrypted === true;
							content = encrypted ? labels.hiddenReasoning : block.text;
							const title = ctx.isGenerating ? labels.thinking : labels.thoughtProcess;
							if (label.textContent !== title) label.textContent = title;
							render();
						},
						destroy() {
							button.onclick = null;
						},
					};
				},
			},
		],
	};
}

export { thinking as ThinkingPlugin };
