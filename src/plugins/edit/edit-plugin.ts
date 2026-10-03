import "./edit.css";
import { extractPlainText } from "../../core/msg-utils";
import type { ChatPlugin, Message } from "../../core/types";
import { el } from "../../utils/dom";
import { ICON_EDIT } from "../../utils/icons";

export interface EditConfig {
	/** Resolves on acceptance. False or rejection keeps the editor open. */
	// biome-ignore lint/suspicious/noConfusingVoidType: Saving may accept without a return value.
	onSave: (messageId: string, newText: string) => boolean | void | Promise<boolean | void>;
}

export function EditPlugin(config: EditConfig): ChatPlugin {
	const editors = new WeakMap<HTMLElement, HTMLElement>();

	const openEditor = (parentEl: HTMLElement, msg: Message) => {
		let editor = editors.get(parentEl);
		if (!editor) {
			editor = el("div", "mur-edit-container");
			parentEl.appendChild(editor);
			editors.set(parentEl, editor);
		}

		const currentText = extractPlainText(msg);

		const blocksWrapper = parentEl.querySelector(".mur-message-blocks-wrapper") as HTMLElement | null;

		let targetHeight = "auto";
		let targetMinWidth = "100%";

		if (blocksWrapper) {
			targetHeight = Math.max(blocksWrapper.offsetHeight, 24) + "px";
			targetMinWidth = blocksWrapper.offsetWidth + "px";
		}

		parentEl.classList.add("mur-editing");

		const textarea = el("textarea", "mur-edit-textarea", { spellcheck: false }) as HTMLTextAreaElement;
		const cancelBtn = el("button", "mur-cancel-edit-btn", { textContent: "Cancel", type: "button" });
		const saveBtn = el("button", "mur-save-edit-btn", { textContent: "Save", type: "button" });
		const controls = el("div", "mur-edit-controls", null, [cancelBtn, saveBtn]);

		editor.replaceChildren(textarea, controls);

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
			parentEl.classList.remove("mur-editing");
			editor.innerHTML = "";
		};

		cancelBtn.addEventListener("click", exitEdit);

		let errorEl: HTMLElement | undefined;
		saveBtn.addEventListener("click", async () => {
			if (saveBtn.disabled) return;
			const newText = textarea.value.trim();
			if (newText === currentText) {
				exitEdit();
				return;
			}
			errorEl?.remove();
			saveBtn.disabled = true;
			textarea.readOnly = true;
			try {
				const accepted = await config.onSave(msg.id, newText);
				if (accepted !== false && editor.contains(textarea)) exitEdit();
			} catch (error) {
				if (!editor.contains(textarea)) return;
				errorEl ??= el("div", "mur-message-error", { role: "alert" });
				errorEl.textContent = error instanceof Error ? error.message : String(error);
				editor.appendChild(errorEl);
			} finally {
				saveBtn.disabled = false;
				textarea.readOnly = false;
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
		getActionButtons: (msg) => {
			if (msg.role !== "user") return [];

			return [
				{
					id: "edit",
					title: "Edit message",
					iconHtml: ICON_EDIT,
					onClick: (ctx) => {
						openEditor(ctx.messageEl, ctx.message);
					},
				},
			];
		},
	};
}
