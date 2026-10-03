import assert from "node:assert/strict";
import { after, type TestContext, test } from "node:test";
import { JSDOM } from "jsdom";
import { Composer } from "../../components/composer";
import type { SubmitCommand } from "../../core/composer-types";
import { AttachmentPlugin, type AttachmentPluginConfig } from "./attachment-plugin";

const dom = new JSDOM();
after(() => dom.window.close());

function setup(t: TestContext, config: AttachmentPluginConfig = {}) {
	const globals = { window: dom.window, document: dom.window.document, FileReader: dom.window.FileReader };
	const old = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	for (const [key, value] of Object.entries(globals))
		Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
	const host = document.createElement("div");
	document.body.replaceChildren(host);
	const plugin = AttachmentPlugin(config);
	const sent: SubmitCommand[] = [];
	const composer = new Composer({
		container: host,
		plugins: [plugin],
		onSubmit: (command) => {
			sent.push(command);
		},
	});
	composer.setConversation("a");
	t.after(() => {
		composer.destroy();
		for (const [key, descriptor] of old) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	});
	return { host, plugin, composer, sent };
}

const file = (name: string, type: string, text = "hello") => new dom.window.File([text], name, { type });

test("local attachments preview images, read text, and retain errors until removed", async (t) => {
	const { host, plugin, composer, sent } = setup(t);
	assert.equal(host.querySelector<HTMLInputElement>('input[type="file"]')!.accept, "image/*,text/*,.csv,.json,.md");
	await plugin.attachFiles([
		file("image.png", "image/png"),
		file("notes.md", "", "# Notes"),
		file("archive.zip", "application/zip"),
	]);
	assert.equal(plugin.getDraft()[2].status, "error");
	assert.match(host.textContent!, /Unsupported type/);
	assert.match(host.querySelector("img")!.src, /^data:image\/png;base64,/);
	await composer.submit();
	assert.equal(sent.length, 0);
	const preview = host.querySelector("img");
	plugin.removeAttachment(plugin.getDraft()[2].id);
	assert.equal(host.querySelector("img"), preview);
	await composer.submit();
	assert.equal(sent[0].blocks.length, 2);
	const text = sent[0].blocks[1];
	assert.equal(text.type, "file");
	if (text.type === "file") {
		assert.equal(text.data, "# Notes");
		assert.equal(text.mimeType, "text/plain");
	}
	assert.equal(plugin.getDraft().length, 0);
});

test("size validation runs before application processing and custom previews are cleaned up", async (t) => {
	const preview = dom.window.document.createElement("div");
	let processed = 0;
	const { host, plugin, composer } = setup(t, {
		acceptedTypes: ".pdf",
		maxFileSize: 2,
		previewContainer: preview,
		onAttach: () => {
			processed++;
			throw new Error("Should not run");
		},
	});
	assert.equal(host.querySelector<HTMLInputElement>('input[type="file"]')!.accept, ".pdf");
	await plugin.attachFiles([file("large.pdf", "application/pdf")]);
	assert.equal(processed, 0);
	assert.match(preview.textContent!, /File too large/);
	composer.destroy();
	assert.equal(preview.childElementCount, 0);
});

test("drop respects editing permissions and detaches its listeners on destroy", async (t) => {
	const { host, plugin, composer } = setup(t, {
		onAttach: ({ file }) => ({
			id: file.name,
			type: "custom",
			kind: "file",
			data: { ref: file.name },
			fallbackText: file.name,
		}),
	});
	const drop = () => {
		const event = new dom.window.Event("drop", { cancelable: true });
		Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [file("a", "text/plain")] } });
		host.firstElementChild!.dispatchEvent(event);
		return event;
	};
	assert.equal(drop().defaultPrevented, true);
	await Promise.resolve();
	assert.equal(plugin.getDraft()[0].status, "ready");
	composer.setCapabilities({ canSubmit: false });
	assert.equal(drop().defaultPrevented, false);
	assert.equal(plugin.getDraft().length, 1);
	const element = host.firstElementChild!;
	composer.destroy();
	const event = new dom.window.Event("drop", { cancelable: true });
	Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [file("b", "text/plain")] } });
	element.dispatchEvent(event);
	assert.equal(event.defaultPrevented, false);
});
