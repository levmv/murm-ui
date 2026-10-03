import assert from "node:assert/strict";
import { after, type TestContext, test } from "node:test";
import { JSDOM } from "jsdom";
import type { SubmitCommand } from "../core/composer-types";
import type { ContentBlock } from "../core/types";
import { AttachmentPlugin, type AttachmentPluginConfig } from "../plugins/attachment/attachment-plugin";
import { Composer, type ComposerConfig } from "./composer";

const dom = new JSDOM();
after(() => dom.window.close());

function setup(t: TestContext, config: Omit<ComposerConfig, "container"> & Pick<AttachmentPluginConfig, "onAttach">) {
	dom.window.document.body.innerHTML = '<div id="host"></div>';
	const globals: Record<string, unknown> = {
		window: dom.window,
		document: dom.window.document,
		CSS: { supports: () => false },
	};
	const old = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	for (const [key, value] of Object.entries(globals))
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	const host = document.getElementById("host")!;
	const { onAttach, ...options } = config;
	const attachments = AttachmentPlugin({ onAttach });
	const composer = new Composer({ container: host, plugins: [attachments], ...options });
	composer.setConversation("a");
	t.after(() => {
		composer.destroy();
		for (const [key, descriptor] of old) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	});
	return {
		composer,
		attachments,
		host,
		send: () => host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true })),
	};
}

const file = (name = "notes.txt") => new dom.window.File(["hello"], name, { type: "text/plain" });
const ref = (id = "file-1"): Extract<ContentBlock, { type: "file" }> => ({
	id,
	type: "file",
	name: `${id}.txt`,
	mimeType: "text/plain",
	data: id,
});

test("pasting files preserves the browser's text paste when both are present", async (t) => {
	const { composer, host, attachments } = setup(t, { onAttach: () => ref(), onSubmit() {} });
	for (const types of [["Files"], ["Files", "text/plain"], ["Files", "text/html"]]) {
		composer.setDraft("");
		const event = new dom.window.Event("paste", { cancelable: true });
		Object.defineProperty(event, "clipboardData", { value: { files: [file()], types } });
		host.querySelector("textarea")!.dispatchEvent(event);
		assert.equal(event.defaultPrevented, types.length === 1);
		await Promise.resolve();
		assert.equal(attachments.getDraft().at(-1)?.status, "ready");
	}
	assert.equal(attachments.getDraft().length, 3);
});

test("standalone composer accepts files without text only after uploads complete", async (t) => {
	const upload = Promise.withResolvers<ContentBlock>();
	const commands: SubmitCommand[] = [];
	const { host, send, attachments } = setup(t, {
		onAttach: () => upload.promise,
		onSubmit: (command) => {
			commands.push(command);
		},
	});
	const pending = attachments.attachFiles([file()]);
	assert.equal(attachments.getDraft()[0].status, "uploading");
	assert.equal(host.querySelector<HTMLButtonElement>(".mur-send-btn")!.disabled, true);
	send();
	assert.equal(commands.length, 0);
	upload.resolve(ref());
	await pending;
	assert.equal(host.querySelector<HTMLButtonElement>(".mur-send-btn")!.disabled, false);
	send();
	await Promise.resolve();
	assert.equal(commands.length, 1);
	assert.equal(commands[0].text, "");
	assert.deepEqual(commands[0].blocks, [ref()]);
	assert.deepEqual(attachments.getDraft(), []);
});

test("late acceptance clears submitted parts and preserves new text and files across conversation switches", async (t) => {
	const accepted = Promise.withResolvers<void>();
	const { composer, host, attachments } = setup(t, {
		onAttach: ({ file }) => ref(file.name),
		onSubmit: () => accepted.promise,
	});
	composer.setDraft("first");
	attachments.setDraft([ref("old")]);
	const pending = composer.submit();
	composer.setDraft("second");
	await attachments.attachFiles([file("new")]);
	composer.setConversation("b");
	composer.setDraft("other");
	attachments.setDraft([ref("b")]);
	accepted.resolve();
	await pending;
	assert.equal(host.querySelector("textarea")!.value, "other");
	composer.setConversation("a");
	assert.equal(host.querySelector("textarea")!.value, "second");
	const items = attachments.getDraft();
	assert.equal(items.length, 1);
	assert.equal(items[0].status, "ready");
	assert.equal(items[0].name, "new.txt");
});

test("adding an attachment while awaiting acceptance does not resend the accepted text", async (t) => {
	const accepted = Promise.withResolvers<void>();
	const { composer, attachments } = setup(t, { onAttach: () => ref(), onSubmit: () => accepted.promise });
	composer.setDraft("sent");
	const pending = composer.submit();
	await attachments.attachFiles([file()]);
	accepted.resolve();
	await pending;
	assert.equal(composer.getDraft(), "");
	assert.equal(attachments.getDraft().length, 1);
});

test("restoring an identical attachment during acceptance creates a new draft entry", async (t) => {
	const accepted = Promise.withResolvers<void>();
	const { composer, attachments } = setup(t, { onSubmit: () => accepted.promise });
	composer.setDraft("");
	attachments.setDraft([ref()]);
	const pending = composer.submit();
	composer.setDraft("");
	attachments.setDraft([ref()]);
	accepted.resolve();
	await pending;
	assert.equal(attachments.getDraft().length, 1);
});

test("upload completion belongs to its original conversation and cannot resurrect removed files", async (t) => {
	const uploads = [Promise.withResolvers<ContentBlock>(), Promise.withResolvers<ContentBlock>()];
	const signals: AbortSignal[] = [];
	const { composer, attachments } = setup(t, {
		onSubmit() {},
		onAttach: ({ signal }) => {
			signals.push(signal);
			return uploads[signals.length - 1].promise;
		},
	});
	const first = attachments.attachFiles([file()]);
	composer.setConversation("b");
	uploads[0].resolve(ref("a"));
	await first;
	assert.equal(attachments.getDraft().length, 0);
	composer.setConversation("a");
	assert.equal(attachments.getDraft()[0].status, "ready");
	const second = attachments.attachFiles([file()]);
	attachments.removeAttachment(attachments.getDraft()[1].id);
	assert.equal(signals[1].aborted, true);
	uploads[1].resolve(ref("removed"));
	await second;
	assert.equal(attachments.getDraft().length, 1);
});

test("upload failures stay visible and block partial submission until removed", async (t) => {
	const commands: SubmitCommand[] = [];
	const { composer, host, attachments } = setup(t, {
		onSubmit: (command) => {
			commands.push(command);
		},
		onAttach: () => {
			throw new Error("Too large <script>");
		},
	});
	composer.setDraft("text");
	await attachments.attachFiles([file()]);
	assert.match(host.textContent!, /Too large <script>/);
	assert.equal(host.querySelector("script"), null);
	await composer.submit();
	assert.equal(commands.length, 0);
	attachments.removeAttachment(attachments.getDraft()[0].id);
	await composer.submit();
	assert.equal(commands.length, 1);
});

test("retry retains request id and isolated payload until a draft part changes", async (t) => {
	const ids: string[] = [];
	const original = ref();
	const { composer, attachments } = setup(t, {
		onSubmit: (command) => {
			ids.push(command.clientRequestId);
			assert.equal(command.blocks[0].type, "file");
			if (command.blocks[0].type === "file") command.blocks[0].name = "mutated";
			if (ids.length === 1) return false;
			throw new Error("Offline");
		},
	});
	composer.setDraft("");
	attachments.setDraft([original]);
	original.name = "changed outside";
	await composer.submit();
	await composer.submit();
	assert.equal(ids[0], ids[1]);
	assert.equal(attachments.getDraft()[0].name, "file-1.txt");
	composer.setDraft("updated");
	await composer.submit();
	assert.notEqual(ids[1], ids[2]);
});

test("read-only capabilities guard file, text-submit and remove entry points", async (t) => {
	let calls = 0;
	const { composer, host, attachments } = setup(t, {
		onSubmit: () => {
			calls++;
		},
		onAttach: () => {
			calls++;
			return ref();
		},
	});
	composer.setDraft("draft");
	attachments.setDraft([ref()]);
	composer.setCapabilities({ canSubmit: false });
	await attachments.attachFiles([file()]);
	attachments.removeAttachment(attachments.getDraft()[0].id);
	await composer.submit();
	assert.equal(calls, 0);
	assert.equal(attachments.getDraft().length, 1);
	assert.equal(host.querySelector("textarea")!.readOnly, true);
	assert.equal(host.querySelector<HTMLButtonElement>(".mur-attach-btn")!.disabled, true);
});

test("destroy aborts acceptance and uploads, and late callbacks do not change DOM", async (t) => {
	const accepted = Promise.withResolvers<void>();
	const upload = Promise.withResolvers<ContentBlock>();
	let submitSignal!: AbortSignal;
	let uploadSignal!: AbortSignal;
	const { composer, host, attachments } = setup(t, {
		onSubmit: ({ signal }) => {
			submitSignal = signal;
			return accepted.promise;
		},
		onAttach: ({ signal }) => {
			uploadSignal = signal;
			return upload.promise;
		},
	});
	composer.setDraft("hello");
	const submission = composer.submit();
	const attachment = attachments.attachFiles([file()]);
	composer.destroy();
	assert.equal(submitSignal.aborted, true);
	assert.equal(uploadSignal.aborted, true);
	accepted.resolve();
	upload.resolve(ref());
	await Promise.all([submission, attachment]);
	assert.equal(host.childElementCount, 0);
});

test("labels apply to visible text and accessible names without interpreting markup", async (t) => {
	const { host, attachments } = setup(t, {
		onSubmit() {},
		onAttach: () => ref(),
		labels: {
			message: "Сообщение",
			messagePlaceholder: "Написать…",
			send: "Отправить",
			attach: "Прикрепить",
			removeAttachment: (name) => `Удалить <${name}>`,
		},
	});
	await attachments.attachFiles([file()]);
	assert.equal(host.querySelector("textarea")!.getAttribute("aria-label"), "Сообщение");
	assert.equal(host.querySelector("textarea")!.placeholder, "Написать…");
	assert.equal(host.querySelector(".mur-send-btn")!.getAttribute("aria-label"), "Отправить");
	assert.equal(host.querySelector(".mur-attachment-remove-btn")!.getAttribute("aria-label"), "Удалить <file-1.txt>");
});

test("one button switches between stop and send as the user edits the draft", async (t) => {
	const commands: SubmitCommand[] = [];
	const stops: string[] = [];
	const { composer, host, send } = setup(t, {
		onSubmit: (command) => {
			commands.push(command);
		},
		onStop: ({ conversationId }) => {
			stops.push(conversationId);
		},
	});
	composer.setCapabilities({ canStop: true });
	const button = host.querySelector<HTMLButtonElement>(".mur-send-btn")!;
	const input = host.querySelector("textarea")!;
	assert.equal(button.getAttribute("aria-label"), "Stop generation");
	assert.equal(button.classList.contains("mur-generating"), true);
	assert.equal(button.disabled, false);
	input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
	assert.deepEqual(stops, []);
	input.value = "next message";
	input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	assert.equal(button.getAttribute("aria-label"), "Send message");
	assert.equal(button.classList.contains("mur-generating"), false);
	send();
	await Promise.resolve();
	assert.equal(commands[0].text, "next message");
	assert.equal(input.value, "");
	assert.equal(button.getAttribute("aria-label"), "Stop generation");
	send();
	await Promise.resolve();
	assert.deepEqual(stops, ["a"]);
	// An acknowledgement does not assume the server has already stopped.
	assert.equal(button.getAttribute("aria-label"), "Stop generation");
	composer.setCapabilities({ canStop: false });
	assert.equal(button.getAttribute("aria-label"), "Send message");
	assert.equal(button.disabled, true);
});

test("files select send during work, and incomplete uploads cannot turn a submit into stop", async (t) => {
	const upload = Promise.withResolvers<ContentBlock>();
	let stops = 0;
	const commands: SubmitCommand[] = [];
	const { composer, host, send, attachments } = setup(t, {
		onSubmit: (command) => {
			commands.push(command);
		},
		onStop: () => {
			stops++;
		},
		onAttach: () => upload.promise,
	});
	composer.setCapabilities({ canStop: true });
	const pending = attachments.attachFiles([file()]);
	const button = host.querySelector<HTMLButtonElement>(".mur-send-btn")!;
	assert.equal(button.getAttribute("aria-label"), "Send message");
	assert.equal(button.disabled, true);
	send();
	assert.equal(stops, 0);
	assert.equal(commands.length, 0);
	upload.reject(new Error("Upload failed"));
	await pending;
	send();
	assert.equal(stops, 0);
	assert.equal(button.getAttribute("aria-label"), "Send message");
	assert.equal(button.disabled, true);
	attachments.removeAttachment(attachments.getDraft()[0].id);
	assert.equal(button.getAttribute("aria-label"), "Stop generation");
	composer.setDraft("");
	attachments.setDraft([ref()]);
	assert.equal(button.getAttribute("aria-label"), "Send message");
	assert.equal(button.disabled, false);
	send();
	await Promise.resolve();
	assert.equal(commands[0].text, "");
	assert.equal(commands[0].blocks.length, 1);
	assert.equal(button.getAttribute("aria-label"), "Stop generation");
});

test("stop stays available when submission is forbidden and never clears a draft", async (t) => {
	let stops = 0;
	let submissions = 0;
	const { composer, host, send } = setup(t, {
		onSubmit: () => {
			submissions++;
		},
		onStop: () => {
			stops++;
		},
	});
	composer.setDraft("draft");
	composer.setCapabilities({ canSubmit: false, canStop: true });
	assert.equal(host.querySelector(".mur-send-btn")!.getAttribute("aria-label"), "Stop generation");
	send();
	await Promise.resolve();
	await composer.submit();
	assert.equal(stops, 1);
	assert.equal(submissions, 0);
	assert.equal(composer.getDraft(), "draft");
	composer.setCapabilities({ canStop: false });
	send();
	await composer.stop();
	assert.equal(stops, 1);
});

test("pending stop is deduplicated per conversation and late failure cannot affect another visit", async (t) => {
	const first = Promise.withResolvers<void>();
	const calls: string[] = [];
	const { composer, host, send } = setup(t, {
		onSubmit() {},
		onStop: ({ conversationId }) => {
			calls.push(conversationId);
			return calls.length === 1 ? first.promise : undefined;
		},
	});
	composer.setConversation("a", { canStop: true });
	send();
	send();
	assert.equal(host.querySelector<HTMLButtonElement>(".mur-send-btn")!.disabled, true);
	assert.deepEqual(calls, ["a"]);
	composer.setConversation("b", { canStop: true });
	send();
	await Promise.resolve();
	assert.deepEqual(calls, ["a", "b"]);
	composer.setConversation("a", { canStop: false });
	composer.setDraft("new draft");
	first.reject(new Error("Stale stop failure"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(host.querySelector<HTMLElement>(".mur-composer-error")!.hidden, true);
	assert.equal(composer.getDraft(), "new draft");
	assert.equal(host.querySelector(".mur-send-btn")!.getAttribute("aria-label"), "Send message");
});

test("stop errors can be retried and destroying a composer never requests stop", async (t) => {
	const pending = Promise.withResolvers<void>();
	let stops = 0;
	const { composer, host } = setup(t, {
		onSubmit() {},
		onStop() {
			stops++;
			if (stops === 1) throw new Error("Offline <script>");
			return pending.promise;
		},
	});
	composer.setCapabilities({ canStop: true });
	await composer.stop();
	assert.match(host.querySelector(".mur-composer-error")!.textContent!, /Offline <script>/);
	assert.equal(host.querySelector("script"), null);
	const retry = composer.stop();
	composer.destroy();
	pending.resolve();
	await retry;
	assert.equal(stops, 2);
	assert.equal(host.childElementCount, 0);
});

test("typing changes button state only on content transitions; Enter respects IME and Shift", async (t) => {
	const commands: SubmitCommand[] = [];
	const { host } = setup(t, {
		onSubmit: (command) => {
			commands.push(command);
		},
	});
	const input = host.querySelector("textarea")!;
	const button = host.querySelector(".mur-send-btn")!;
	input.value = "a";
	input.dispatchEvent(new dom.window.Event("input"));
	const observer = new dom.window.MutationObserver(() => {});
	observer.observe(button, { attributes: true, childList: true, subtree: true });
	for (const text of ["ab", "abc", "abcd"]) {
		input.value = text;
		input.dispatchEvent(new dom.window.Event("input"));
	}
	assert.equal(observer.takeRecords().length, 0);
	observer.disconnect();
	for (const options of [{ shiftKey: true }, { isComposing: true }]) {
		const event = new dom.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true, ...options });
		input.dispatchEvent(event);
		assert.equal(event.defaultPrevented, false);
	}
	assert.equal(commands.length, 0);
	input.value = "  programmatic value\n";
	input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
	await Promise.resolve();
	assert.equal(commands[0].text, "  programmatic value\n");
});

test("textarea fallback obeys CSS max-height and adoption preserves its accessible label", (t) => {
	const { host, composer } = setup(t, { onSubmit() {} });
	const input = host.querySelector("textarea")!;
	Object.defineProperty(input, "scrollHeight", { value: 500 });
	input.style.maxHeight = "280px";
	composer.setDraft("long text");
	assert.equal(input.style.height, "280px");
	composer.destroy();
	host.innerHTML =
		'<form class="mur-chat-form"><label for="prompt">Custom prompt</label><textarea id="prompt" class="mur-chat-input"></textarea><button class="mur-send-btn"></button></form>';
	const adopted = new Composer({ container: host, form: host.querySelector("form")!, onSubmit() {} });
	t.after(() => adopted.destroy());
	assert.equal(host.querySelector("textarea")!.hasAttribute("aria-label"), false);
	assert.equal(host.querySelector('input[type="file"]'), null);
	assert.equal(host.querySelector(".mur-attachment-previews"), null);
});
