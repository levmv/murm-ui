import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { Input } from "../../components/input";
import type { ChatPlugin, Message } from "../../core/types";
import { AttachmentPlugin } from "./attachment-plugin";

function setGlobal(name: string, value: unknown): void {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
		writable: true,
	});
}

function installDom(): HTMLElement {
	const dom = new JSDOM(`
		<div class="mur-app">
			<form class="mur-chat-form">
				<textarea class="mur-chat-input" rows="1"></textarea>
				<button type="submit" class="mur-send-btn">Send</button>
			</form>
		</div>
	`);

	Object.defineProperty(dom.window, "matchMedia", {
		configurable: true,
		value: () => ({ matches: false }),
	});

	setGlobal("window", dom.window);
	setGlobal("document", dom.window.document);
	setGlobal("navigator", dom.window.navigator);
	setGlobal("HTMLElement", dom.window.HTMLElement);
	setGlobal("File", dom.window.File);
	setGlobal("FileReader", dom.window.FileReader);
	setGlobal("Event", dom.window.Event);
	setGlobal("CSS", { supports: () => false });

	return dom.window.document.querySelector(".mur-app") as HTMLElement;
}

function mountAttachment(plugin: ChatPlugin): {
	container: HTMLElement;
	fileInput: HTMLInputElement;
	form: HTMLFormElement;
	input: HTMLTextAreaElement;
	sendBtn: HTMLButtonElement;
	submissions: string[];
	destroy: () => void;
} {
	const container = installDom();
	const submissions: string[] = [];
	const inputComponent = new Input(
		{
			container,
			onSubmit: (text) => submissions.push(text),
			onStop: () => {},
		},
		[plugin],
	);

	const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
	assert.ok(fileInput);

	return {
		container,
		fileInput,
		form: container.querySelector(".mur-chat-form") as HTMLFormElement,
		input: container.querySelector(".mur-chat-input") as HTMLTextAreaElement,
		sendBtn: container.querySelector(".mur-send-btn") as HTMLButtonElement,
		submissions,
		destroy: () => {
			plugin.destroy?.();
			inputComponent.destroy();
		},
	};
}

function dispatchFileInput(fileInput: HTMLInputElement, files: File[]): void {
	Object.defineProperty(fileInput, "files", {
		configurable: true,
		value: files,
	});
	fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function dispatchDrop(container: HTMLElement, files: File[]): boolean {
	const event = new window.Event("drop", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "dataTransfer", {
		configurable: true,
		value: { types: ["Files"], files },
	});
	return container.dispatchEvent(event);
}

function dispatchDrag(container: HTMLElement, type: string): void {
	const event = new window.Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, "dataTransfer", {
		configurable: true,
		value: { types: ["Files"], files: [] },
	});
	container.dispatchEvent(event);
}

function dispatchPaste(input: HTMLTextAreaElement, files: File[]): boolean {
	const event = new window.Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "clipboardData", {
		configurable: true,
		value: { files },
	});
	return input.dispatchEvent(event);
}

async function waitFor(assertion: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 30; i++) {
		if (assertion()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	assert.fail(`Timed out waiting for ${label}`);
}

function file(name: string, type: string, content = "hello"): File {
	return new File([content], name, { type });
}

function message(): Message {
	return { id: "message-1", role: "user", blocks: [] };
}

test("file input uses default and custom accepted types", () => {
	const defaultPlugin = AttachmentPlugin();
	const defaultHarness = mountAttachment(defaultPlugin);
	assert.equal(defaultHarness.fileInput.accept, "image/*,text/*,.csv,.json,.md");
	defaultHarness.destroy();

	const customPlugin = AttachmentPlugin({ acceptedTypes: ".pdf" });
	const customHarness = mountAttachment(customPlugin);
	assert.equal(customHarness.fileInput.accept, ".pdf");
	customHarness.destroy();
});

test("local image and text fallback succeed while unsupported binaries render errors", async () => {
	const plugin = AttachmentPlugin();
	const harness = mountAttachment(plugin);

	dispatchFileInput(harness.fileInput, [
		file("image.png", "image/png", "image-data"),
		file("notes.md", "text/markdown", "# Notes"),
		file("archive.zip", "application/zip", "zip"),
	]);

	await waitFor(() => harness.container.querySelectorAll(".mur-attachment-ready").length === 2, "ready files");
	await waitFor(() => harness.container.querySelectorAll(".mur-attachment-error").length === 1, "error file");

	const msg = message();
	plugin.onUserSubmit?.(msg);

	assert.equal(msg.blocks.length, 2);
	assert.equal(msg.blocks[0].type, "file");
	assert.equal(msg.blocks[1].type, "file");
	assert.match(harness.container.textContent ?? "", /Unsupported type/);

	harness.destroy();
});

test("size exceeded renders an error and calls the size hook", async () => {
	const oversized = file("large.txt", "text/plain", "too large");
	const calls: string[] = [];
	const plugin = AttachmentPlugin({
		maxFileSize: 2,
		onSizeExceeded: (selectedFile, maxSize) => calls.push(`${selectedFile.name}:${maxSize}`),
	});
	const harness = mountAttachment(plugin);

	dispatchFileInput(harness.fileInput, [oversized]);

	await waitFor(() => harness.container.querySelector(".mur-attachment-error") !== null, "size error");
	assert.deepEqual(calls, ["large.txt:2"]);
	assert.match(harness.container.textContent ?? "", /File too large/);

	harness.destroy();
});

test("custom handlers run before upload fallback", async () => {
	const calls: string[] = [];
	const plugin = AttachmentPlugin({
		uploadFile: async (selectedFile) => {
			calls.push(`upload:${selectedFile.name}`);
			return { type: "text/plain", data: "uploaded", name: selectedFile.name };
		},
		fileHandlers: [
			{
				accepts: (selectedFile) => selectedFile.name.endsWith(".pdf"),
				process: async (selectedFile) => {
					calls.push(`handler:${selectedFile.name}`);
					return {
						id: "pdf-block",
						type: "file",
						mimeType: "application/pdf",
						name: selectedFile.name,
						data: "parsed-pdf",
					};
				},
			},
		],
	});
	const harness = mountAttachment(plugin);

	dispatchFileInput(harness.fileInput, [file("doc.pdf", "application/pdf", "%PDF")]);
	await waitFor(() => plugin.hasPendingData?.() === true, "handler file ready");

	const msg = message();
	plugin.onUserSubmit?.(msg);

	assert.deepEqual(calls, ["handler:doc.pdf"]);
	assert.equal(msg.blocks[0].type, "file");
	assert.equal(msg.blocks[0].data, "parsed-pdf");

	harness.destroy();
});

test("upload fallback creates file content blocks", async () => {
	const plugin = AttachmentPlugin({
		uploadFile: async (selectedFile) => ({
			type: "application/octet-stream",
			data: `remote:${selectedFile.name}`,
			name: "remote.bin",
		}),
	});
	const harness = mountAttachment(plugin);

	dispatchFileInput(harness.fileInput, [file("local.bin", "application/octet-stream", "binary")]);
	await waitFor(() => plugin.hasPendingData?.() === true, "uploaded file ready");

	const msg = message();
	plugin.onUserSubmit?.(msg);

	assert.equal(msg.blocks.length, 1);
	assert.equal(msg.blocks[0].type, "file");
	assert.equal(msg.blocks[0].mimeType, "application/octet-stream");
	assert.equal(msg.blocks[0].name, "remote.bin");
	assert.equal(msg.blocks[0].data, "remote:local.bin");

	harness.destroy();
});

test("submission is blocked while processing and enabled after resolution", async () => {
	let resolveUpload: ((value: { type: string; data: string; name?: string }) => void) | null = null;
	const plugin = AttachmentPlugin({
		uploadFile: async () =>
			new Promise((resolve) => {
				resolveUpload = resolve;
			}),
	});
	const harness = mountAttachment(plugin);

	dispatchFileInput(harness.fileInput, [file("slow.bin", "application/octet-stream", "binary")]);
	assert.equal(plugin.isSubmitBlocked?.(), true);
	assert.equal(harness.sendBtn.disabled, true);

	harness.input.value = "hello";
	harness.form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
	assert.deepEqual(harness.submissions, []);

	assert.ok(resolveUpload);
	resolveUpload({ type: "application/octet-stream", data: "done", name: "slow.bin" });
	await waitFor(() => plugin.isSubmitBlocked?.() === false, "upload resolved");

	assert.equal(harness.sendBtn.disabled, false);
	harness.form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
	assert.deepEqual(harness.submissions, ["hello"]);

	harness.destroy();
});

test("drop and paste queue files", async () => {
	const plugin = AttachmentPlugin();
	const harness = mountAttachment(plugin);

	dispatchDrag(harness.container, "dragenter");
	assert.equal(harness.container.classList.contains("mur-attachment-drag-active"), true);

	const dropAllowed = dispatchDrop(harness.container, [file("drop.txt", "text/plain", "drop")]);
	assert.equal(dropAllowed, false);
	assert.equal(harness.container.classList.contains("mur-attachment-drag-active"), false);

	const pasteAllowed = dispatchPaste(harness.input, [file("paste.txt", "text/plain", "paste")]);
	assert.equal(pasteAllowed, false);

	await waitFor(() => harness.container.querySelectorAll(".mur-attachment-ready").length === 2, "drop and paste ready");

	harness.destroy();
});

test("destroy removes attachment listeners and nodes", () => {
	const plugin = AttachmentPlugin();
	const harness = mountAttachment(plugin);

	harness.destroy();
	dispatchDrop(harness.container, [file("drop.txt", "text/plain", "drop")]);
	dispatchPaste(harness.input, [file("paste.txt", "text/plain", "paste")]);

	assert.equal(harness.container.querySelector(".mur-attachment-previews"), null);
	assert.equal(harness.container.classList.contains("mur-attachment-drag-active"), false);
});
