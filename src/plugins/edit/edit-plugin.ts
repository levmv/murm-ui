import "./edit.css";
import { extractPlainText } from "../../core/msg-utils";
import type { ChatPlugin, Message } from "../../core/types";
import { el, replaceNodes } from "../../utils/dom";

export interface EditConfig {
	onSave: (messageId: string, newText: string) => void;
}

interface EditState {
	isEditing: boolean;
	editContainer: HTMLElement;
	currentMsg: Message;
}

export function EditPlugin(config: EditConfig): ChatPlugin {
	const stateMap = new WeakMap<HTMLElement, EditState>();

	const enterEditMode = (parentEl: HTMLElement, state: EditState) => {
		const msg = state.currentMsg;
		const currentText = extractPlainText(msg);

		const blocksWrapper = parentEl.querySelector(".mur-message-blocks-wrapper") as HTMLElement | null;

		let targetHeight = "auto";
		let targetMinWidth = "100%";

		if (blocksWrapper) {
			targetHeight = Math.max(blocksWrapper.offsetHeight, 24) + "px";
			targetMinWidth = blocksWrapper.offsetWidth + "px";
		}

		state.isEditing = true;
		parentEl.classList.add("mur-editing");

		const textarea = el("textarea", "mur-edit-textarea", { spellcheck: false }) as HTMLTextAreaElement;
		const cancelBtn = el("button", "mur-cancel-edit-btn", { textContent: "Cancel" });
		const saveBtn = el("button", "mur-save-edit-btn", { textContent: "Save" });
		const controls = el("div", "mur-edit-controls", null, [cancelBtn, saveBtn]);

		replaceNodes(state.editContainer, textarea, controls);

		textarea.style.height = targetHeight;
		textarea.style.minWidth = targetMinWidth;
		textarea.value = currentText;

		textarea.addEventListener("input", () => {
			textarea.style.height = "auto";
			textarea.style.height = textarea.scrollHeight + "px";
		});

		textarea.focus();
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);

		const exitEdit = () => {
			state.isEditing = false;
			parentEl.classList.remove("mur-editing");
			state.editContainer.innerHTML = "";
		};

		cancelBtn.addEventListener("click", exitEdit);

		saveBtn.addEventListener("click", () => {
			const newText = textarea.value.trim();
			if (newText && newText !== currentText) {
				config.onSave(msg.id, newText);
				exitEdit();
			} else {
				exitEdit();
			}
		});

		textarea.addEventListener("keydown", (e) => {
			if (e.key === "Escape") exitEdit();

			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				saveBtn.click();
			}
		});
	};

	return {
		name: "edit",
		onMessageRender: (msg, parentEl, _isGenerating) => {
			if (msg.role !== "user") return;

			let state = stateMap.get(parentEl);

			if (!state) {
				const editBtn = el("button", "mur-action-icon-btn", {
					title: "Edit message",
					innerHTML: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 20h9"></path>
                        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                    </svg>`,
				});

				const actionBar = el("div", "mur-message-actions", null, [editBtn]);
				const editContainer = el("div", "mur-edit-container");

				parentEl.appendChild(actionBar);
				parentEl.appendChild(editContainer);

				state = {
					isEditing: false,
					editContainer,
					currentMsg: msg,
				};

				editBtn.addEventListener("click", () => enterEditMode(parentEl, state!));
				stateMap.set(parentEl, state);
			}
			state.currentMsg = msg;
		},
	};
}
