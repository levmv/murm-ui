import "./attachment.css";
import type { ComposerContext, ComposerExtension, ComposerPlugin } from "../../core/composer-types";
import { cloneBlock } from "../../core/msg-utils";
import type { ContentBlock, DeepReadonly } from "../../core/types";
import { el } from "../../utils/dom";
import { ICON_PAPERCLIP } from "../../utils/icons";
import { uuidv7 } from "../../utils/uuid";

const DEFAULT_ACCEPTED_TYPES = "image/*,text/*,.csv,.json,.md";
const TEXT_FILE_EXTENSIONS = new Set(["csv", "json", "md"]);

export type DraftAttachment = { id: string; name: string } & (
	| { status: "uploading" }
	| { status: "ready"; value: ContentBlock }
	| { status: "error"; error: string }
);

export interface AttachmentPluginConfig {
	/** Maximum file size in bytes. Default: 20 MiB. */
	maxFileSize?: number;
	/** File-picker hint; onAttach validates application-specific formats. */
	acceptedTypes?: string;
	/** Upload or process a file into a message block. Defaults to local images and text files. */
	onAttach?: (request: {
		conversationId: string;
		file: File;
		signal: AbortSignal;
	}) => ContentBlock | Promise<ContentBlock>;
	/** Defaults to the area before the form. */
	previewContainer?: HTMLElement;
}

export interface AttachmentExtension extends ComposerPlugin {
	getDraft(conversationId?: string): DeepReadonly<DraftAttachment[]>;
	setDraft(blocks: readonly ContentBlock[], conversationId?: string): void;
	attachFiles(files: Iterable<File>): Promise<void>;
	removeAttachment(id: string): void;
}

interface Preview {
	el: HTMLElement;
	content: HTMLElement;
	remove: HTMLButtonElement;
	item?: DraftAttachment;
}

export function AttachmentPlugin(config: AttachmentPluginConfig = {}): AttachmentExtension {
	const drafts = new Map<string, DraftAttachment[]>();
	const uploads = new Map<string, AbortController>();
	const previews = new Map<string, Preview>();
	let context: ComposerContext;
	let tray: HTMLElement;
	let button: HTMLButtonElement;
	let destroyed = false;

	const draft = (id = context.conversationId): DraftAttachment[] => {
		let items = drafts.get(id);
		if (!items) {
			items = [];
			drafts.set(id, items);
		}
		return items;
	};
	const abort = (id: string) => {
		uploads.get(id)?.abort();
		uploads.delete(id);
	};
	const changed = (id: string) => {
		if (destroyed) return;
		context.changed(id);
		if (id === context.conversationId) render();
	};
	const render = () => {
		button.disabled = !context.canEdit;
		const items = draft();
		const ids = new Set(items.map((item) => item.id));
		for (const [id, node] of previews) {
			if (ids.has(id)) continue;
			node.el.remove();
			previews.delete(id);
		}
		for (const [index, item] of items.entries()) {
			let node = previews.get(item.id);
			if (!node) {
				const content = el("div", "mur-file-preview");
				const remove = el("button", "mur-attachment-remove-btn", { type: "button", textContent: "×" });
				remove.addEventListener("click", () => plugin.removeAttachment(item.id));
				node = { el: el("div", "mur-attachment-preview-item", null, [content, remove]), content, remove };
				previews.set(item.id, node);
			}
			if (node.item !== item) {
				node.item = item;
				node.el.dataset.attachmentState = item.status;
				const block = item.status === "ready" ? item.value : undefined;
				if (block?.type === "file" && block.mimeType.startsWith("image/")) {
					node.content.replaceChildren(el("img", "", { src: block.data, alt: item.name }));
				} else
					node.content.textContent =
						item.status === "uploading"
							? `${item.name} · ${context.labels.uploading}`
							: item.status === "error"
								? `${item.name} · ${item.error}`
								: item.name;
				node.remove.setAttribute("aria-label", context.labels.removeAttachment(item.name));
			}
			node.remove.disabled = !context.canEdit;
			if (tray.children[index] !== node.el) tray.insertBefore(node.el, tray.children[index]);
		}
		tray.hidden = items.length === 0;
	};

	const plugin: AttachmentExtension = {
		name: "attachments",
		getDraft: (id) => draft(id),
		setDraft(blocks, id = context.conversationId) {
			for (const item of draft(id)) abort(item.id);
			drafts.set(
				id,
				blocks.map((block) => ({
					id: uuidv7(),
					name:
						block.type === "file" ? (block.name ?? "File") : block.type === "custom" ? block.fallbackText : block.id,
					status: "ready",
					value: cloneBlock(block),
				})),
			);
			changed(id);
		},
		async attachFiles(files) {
			if (destroyed || !context.canEdit) return;
			const conversationId = context.conversationId;
			const pending = Array.from(files, (file) => {
				const id = uuidv7();
				const controller = new AbortController();
				draft().push({ id, name: file.name, status: "uploading" });
				uploads.set(id, controller);
				return { id, file, controller };
			});
			changed(conversationId);
			await Promise.all(
				pending.map(async ({ id, file, controller }) => {
					let result: DraftAttachment;
					try {
						if (file.size > (config.maxFileSize ?? 20 * 1024 * 1024)) throw new Error("File too large");
						const block = await (config.onAttach ?? processFile)({ conversationId, file, signal: controller.signal });
						result = {
							id,
							name: block.type === "file" ? (block.name ?? file.name) : file.name,
							status: "ready",
							value: cloneBlock(block),
						};
					} catch (error) {
						result = {
							id,
							name: file.name,
							status: "error",
							error: error instanceof Error ? error.message : String(error),
						};
					} finally {
						uploads.delete(id);
					}
					if (destroyed || controller.signal.aborted) return;
					const items = draft(conversationId);
					const index = items.findIndex((item) => item.id === id);
					if (index >= 0) items[index] = result;
					changed(conversationId);
				}),
			);
		},
		removeAttachment(id) {
			if (destroyed || !context.canEdit) return;
			abort(id);
			drafts.set(
				context.conversationId,
				draft().filter((item) => item.id !== id),
			);
			changed(context.conversationId);
		},
		mountComposer(ctx): ComposerExtension {
			context = ctx;
			tray = el("div", "mur-attachment-previews", { hidden: true });
			tray.setAttribute("aria-label", ctx.labels.attachments);
			tray.setAttribute("aria-live", "polite");
			if (config.previewContainer) config.previewContainer.appendChild(tray);
			else ctx.form.before(tray);
			const picker = el("input", "", {
				type: "file",
				hidden: true,
				multiple: true,
				accept: config.acceptedTypes ?? DEFAULT_ACCEPTED_TYPES,
			});
			button = el("button", "mur-attach-btn mur-form-icon-btn", {
				type: "button",
				innerHTML: ICON_PAPERCLIP,
				title: ctx.labels.attach,
			});
			button.setAttribute("aria-label", ctx.labels.attach);
			button.addEventListener("click", () => picker.click());
			picker.addEventListener("change", () => {
				if (picker.files) void plugin.attachFiles(picker.files);
				picker.value = "";
			});
			ctx.form.prepend(button, picker);
			let dragDepth = 0;
			const hasFiles = (event: DragEvent) => ctx.canEdit && event.dataTransfer?.types.includes("Files");
			const onDragEnter = (event: DragEvent) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				dragDepth++;
				ctx.container.classList.add("mur-attachment-drag-active");
			};
			const onDragOver = (event: DragEvent) => {
				if (hasFiles(event)) event.preventDefault();
			};
			const onDragLeave = () => {
				dragDepth = Math.max(0, dragDepth - 1);
				if (dragDepth === 0) ctx.container.classList.remove("mur-attachment-drag-active");
			};
			const onDrop = (event: DragEvent) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				dragDepth = 0;
				ctx.container.classList.remove("mur-attachment-drag-active");
				void plugin.attachFiles(event.dataTransfer!.files);
			};
			const onPaste = (event: ClipboardEvent) => {
				if (!ctx.canEdit || !event.clipboardData?.files.length) return;
				const { types, files } = event.clipboardData;
				if (!types.includes("text/plain") && !types.includes("text/html")) event.preventDefault();
				void plugin.attachFiles(files);
			};
			ctx.container.addEventListener("dragenter", onDragEnter);
			ctx.container.addEventListener("dragover", onDragOver);
			ctx.container.addEventListener("dragleave", onDragLeave);
			ctx.container.addEventListener("drop", onDrop);
			ctx.input.addEventListener("paste", onPaste);
			return {
				update: render,
				hasContent: () => draft().length > 0,
				isBlocked: () => draft().some((item) => item.status !== "ready"),
				collect() {
					const conversationId = ctx.conversationId;
					const items = draft();
					const ids = new Set(items.map((item) => item.id));
					return {
						blocks: items.flatMap((item) => (item.status === "ready" ? [cloneBlock(item.value)] : [])),
						accept() {
							drafts.set(
								conversationId,
								draft(conversationId).filter((item) => !ids.has(item.id)),
							);
							changed(conversationId);
						},
					};
				},
				destroy() {
					destroyed = true;
					for (const controller of uploads.values()) controller.abort();
					uploads.clear();
					drafts.clear();
					previews.clear();
					ctx.container.removeEventListener("dragenter", onDragEnter);
					ctx.container.removeEventListener("dragover", onDragOver);
					ctx.container.removeEventListener("dragleave", onDragLeave);
					ctx.container.removeEventListener("drop", onDrop);
					ctx.input.removeEventListener("paste", onPaste);
					ctx.container.classList.remove("mur-attachment-drag-active");
					picker.remove();
					button.remove();
					tray.remove();
				},
			};
		},
	};
	return plugin;
}

async function processFile({ file, signal }: { file: File; signal: AbortSignal }): Promise<ContentBlock> {
	const image = file.type.startsWith("image/");
	const dot = file.name.lastIndexOf(".");
	const extension = dot < 0 ? "" : file.name.slice(dot + 1).toLowerCase();
	if (
		!image &&
		!file.type.startsWith("text/") &&
		file.type !== "application/json" &&
		!TEXT_FILE_EXTENSIONS.has(extension)
	)
		throw new Error("Unsupported type");
	const data = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		const abort = () => {
			reader.abort();
			reject(new Error("File reading cancelled"));
		};
		reader.onload = () => {
			signal.removeEventListener("abort", abort);
			resolve(String(reader.result ?? ""));
		};
		reader.onerror = () => {
			signal.removeEventListener("abort", abort);
			reject(reader.error ?? new Error("Failed to read file"));
		};
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		if (image) reader.readAsDataURL(file);
		else reader.readAsText(file);
	});
	return {
		id: uuidv7(),
		type: "file",
		name: file.name,
		mimeType: file.type || (extension === "json" ? "application/json" : "text/plain"),
		data,
	};
}
