import type { MessagePlugin, RendererContext } from "../../src/view";

// Application code: the library knows neither this card's data nor its actions.
export function researchCard(): MessagePlugin {
	return {
		name: "researchCard",
		renderers: [
			{
				matches: (block) => block.type === "custom" && block.kind === "demo/research",
				mount(container) {
					container.classList.add("demo-card");
					const title = document.createElement("h3");
					title.textContent = "Карточка исследования";
					const status = document.createElement("p");
					const input = document.createElement("input");
					input.placeholder = "Заметка к результату…";
					input.setAttribute("aria-label", "Заметка к результату");
					const button = document.createElement("button");
					button.type = "button";
					button.textContent = "Сохранить заметку";
					let context: RendererContext;
					const save = () => context.dispatch("save-note", { text: input.value });
					button.addEventListener("click", save);
					container.append(title, status, input, button);
					return {
						update(block, nextContext) {
							context = nextContext;
							if (block.type !== "custom" || !block.data || typeof block.data !== "object" || Array.isArray(block.data))
								return;
							status.textContent = `Обновление ${block.data.revision ?? 0}. ${block.data.note || "Данные обновляются во время работы агента."}`;
							input.readOnly = !context.canAct;
							button.disabled = !context.canAct;
							// Never replace the input or its current value on a server update.
						},
						destroy() {
							button.removeEventListener("click", save);
							container.classList.remove("demo-card");
						},
					};
				},
			},
		],
	};
}
