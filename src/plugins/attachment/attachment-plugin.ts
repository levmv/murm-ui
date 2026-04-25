import "./attachment.css";
import type { ChatPlugin, ContentBlock, PluginInputContext } from "../../core/types";
import { el } from "../../utils/dom";
import { ICON_PAPERCLIP } from "../../utils/icons";
import { uuidv7 } from "../../utils/uuid";

export interface AttachmentPluginConfig {
	/** Maximum file size in bytes. Default: 20MB */
	maxFileSize?: number;
	/** Callback when a file exceeds the limit. Defaults to window.alert */
	onSizeExceeded?: (file: File, maxSize: number) => void;

	/**
	 * A CSS selector defining where the image preview tray should be mounted.
	 * If omitted, it will be inserted just before the chat form.
	 */
	previewMountSelector?: string;
}

export function AttachmentPlugin(config?: AttachmentPluginConfig): ChatPlugin {
	const maxSize = config?.maxFileSize ?? 20 * 1024 * 1024;
	const handleSizeExceeded =
		config?.onSizeExceeded ??
		((file, max) => {
			alert(`File "${file.name}" exceeds the maximum allowed size of ${Math.round(max / (1024 * 1024))}MB.`);
		});

	// Store pending uploads as content blocks
	let pendingBlocks: Extract<ContentBlock, { type: "file" }>[] = [];

	let fileInput: HTMLInputElement;
	let previewContainer: HTMLElement;
	let attachBtn: HTMLButtonElement;
	let boundOnChange: () => void;

	const renderPreviews = () => {
		if (!previewContainer) return;
		previewContainer.innerHTML = "";
		previewContainer.style.display = pendingBlocks.length ? "flex" : "none";

		pendingBlocks.forEach((block) => {
			const item = el("div", "mur-attachment-preview-item");

			if (block.mimeType.startsWith("image/")) {
				item.appendChild(el("img", "", { src: block.data, alt: block.name }));
			} else {
				item.appendChild(el("div", "mur-file-preview", { textContent: `📄 ${block.name}` }));
			}

			const removeBtn = el("button", "mur-attachment-remove-btn", {
				innerHTML: "×",
				type: "button",
				onclick: () => {
					pendingBlocks = pendingBlocks.filter((b) => b.id !== block.id);
					renderPreviews();
				},
			});

			item.appendChild(removeBtn);
			previewContainer.appendChild(item);
		});
	};

	return {
		name: "attachments",

		onInputMount: (ctx: PluginInputContext) => {
			previewContainer = el("div", "mur-attachment-previews");
			previewContainer.style.display = "none";

			fileInput = el("input", "", { type: "file", hidden: true, multiple: true });

			attachBtn = el("button", "mur-form-icon-btn", {
				type: "button",
				innerHTML: ICON_PAPERCLIP,
				onclick: () => fileInput.click(),
			});

			ctx.form.prepend(attachBtn);
			if (config?.previewMountSelector) {
				const customTarget = document.querySelector(config.previewMountSelector);
				if (customTarget) {
					customTarget.appendChild(previewContainer);
				} else {
					console.error(
						`AttachmentPlugin: Could not find element matching previewMountSelector "${config.previewMountSelector}". Image previews will not be visible.`,
					);
				}
			} else {
				ctx.form.before(previewContainer);
			}
			ctx.form.appendChild(fileInput);

			boundOnChange = async () => {
				const files = Array.from(fileInput.files || []);
				for (const file of files) {
					if (file.size > maxSize) {
						handleSizeExceeded(file, maxSize);
						continue;
					}

					const reader = new FileReader();

					reader.onload = () => {
						pendingBlocks.push({
							id: uuidv7(),
							type: "file",
							mimeType: file.type || "application/octet-stream",
							name: file.name,
							data: reader.result as string,
						});
						renderPreviews();
					};

					if (file.type.startsWith("image/")) reader.readAsDataURL(file);
					else reader.readAsText(file);
				}
				fileInput.value = "";
			};
			fileInput.addEventListener("change", boundOnChange);
		},

		hasPendingData: () => pendingBlocks.length > 0,

		onUserSubmit: (msg) => {
			if (pendingBlocks.length > 0) {
				// Prepend files before the text block
				msg.blocks.unshift(...pendingBlocks);
				pendingBlocks = [];
				renderPreviews();
			}
		},

		destroy: () => {
			if (fileInput && boundOnChange) {
				fileInput.removeEventListener("change", boundOnChange);
			}
			fileInput?.remove();
			attachBtn?.remove();
			previewContainer?.remove();
			pendingBlocks = [];
		},
	};
}
