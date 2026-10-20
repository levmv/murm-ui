import assert from "node:assert/strict";
import { after, type TestContext, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import { ConversationModel } from "../core/conversation";
import type {
	ActionButtonDef,
	BlockAction,
	BlockRenderer,
	ContentBlock,
	Message,
	MessageActionContext,
	RendererContext,
} from "../core/types";
import { agentThinking } from "../plugins/agent-thinking/agent-thinking-plugin";
import { AttachmentPlugin } from "../plugins/attachment/attachment-plugin";
import { CopyPlugin } from "../plugins/copy/copy-plugin";
import { EditPlugin } from "../plugins/edit/edit-plugin";
import { ThinkingPlugin } from "../plugins/thinking/thinking-plugin";
import { ToolsPlugin } from "../plugins/tools/tools-plugin";
import { ChatView, type ChatViewConfig } from "./chat-view";

// Reuse a document realm for the shared HTML parser; give each view a fresh host.
const dom = new JSDOM();
after(() => dom.window.close());

function message(id: string, text = id): Message {
	return { id, role: "assistant", blocks: [{ id: `${id}-text`, type: "text", text }] };
}

function setup(t: TestContext, config: Omit<ChatViewConfig, "container"> = {}) {
	dom.window.document.body.innerHTML = '<div id="host"></div>';
	const frames = new Map<number, FrameRequestCallback>();
	let frameId = 0;
	dom.window.matchMedia = (media) => ({
		matches: false,
		media,
		onchange: null,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
		dispatchEvent: () => false,
	});
	dom.window.HTMLElement.prototype.scrollTo = () => {};
	const globals: Record<string, unknown> = {
		window: dom.window,
		document: dom.window.document,
		HTMLElement: dom.window.HTMLElement,
		Node: dom.window.Node,
		NodeFilter: dom.window.NodeFilter,
		DOMParser: dom.window.DOMParser,
		navigator: { clipboard: { writeText: async () => {} } },
		CSS: { supports: () => false },
		ResizeObserver: undefined,
		requestAnimationFrame: (fn: FrameRequestCallback) => {
			frames.set(++frameId, fn);
			return frameId;
		},
		cancelAnimationFrame: (id: number) => {
			frames.delete(id);
		},
	};
	const old = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	for (const [key, value] of Object.entries(globals))
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	const host = document.getElementById("host")!;
	const view = new ChatView({ container: host, ...config });
	t.after(() => {
		view.destroy();
		for (const [key, descriptor] of old) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	});
	return {
		view,
		host,
		frameCount: () => frames.size,
		flush() {
			const callbacks = [...frames.values()];
			frames.clear();
			for (const callback of callbacks) callback(0);
		},
	};
}

test("standalone view needs only a host; Markdown and unknown cards stay safe", async (t) => {
	const parse = t.mock.method(marked, "parse");
	const { view, host, flush } = setup(t);
	view.setConversation({
		id: "c",
		messages: [
			message("a", "**formatted** <script>bad()</script>"),
			{
				id: "b",
				role: "assistant",
				blocks: [{ id: "card", type: "custom", kind: "unknown", data: {}, fallbackText: "<img src=x onerror=bad()>" }],
			},
		],
	});
	await view.whenRendered();
	assert.equal(host.querySelector("textarea"), null);
	assert.equal(host.querySelector("script, img"), null);
	assert.equal(host.querySelector("strong")?.textContent, "formatted");
	assert.match(host.textContent!, /<img/);
	view.apply({ conversationId: "c", changes: [{ type: "message.state", messageId: "a", status: "streaming" }] });
	flush();
	view.apply({ conversationId: "c", changes: [{ type: "message.state", messageId: "a", status: "complete" }] });
	await view.whenRendered();
	assert.equal(parse.mock.callCount(), 1, "default Markdown does not reparse unchanged text on completion");
	view.destroy();
	assert.equal(host.childElementCount, 0);
});

test("message editing retains rejected drafts and waits for acceptance", async (t) => {
	let pending = Promise.withResolvers<boolean>();
	const saved: string[] = [];
	const { view, host, flush } = setup(t, {
		plugins: [
			EditPlugin({
				onSave: (id, text) => {
					assert.equal(id, "u");
					saved.push(text);
					return pending.promise;
				},
			}),
		],
	});
	view.setConversation({ id: "c", messages: [{ ...message("u", "Original"), role: "user" }] });
	flush();
	host.querySelector<HTMLButtonElement>('[data-action-id="edit"]')!.click();
	const textarea = host.querySelector<HTMLTextAreaElement>(".mur-edit-textarea")!;
	const save = host.querySelector<HTMLButtonElement>(".mur-save-edit-btn")!;
	assert.equal(textarea.value, "Original");
	textarea.value = "Edited";
	save.click();
	save.click();
	assert.equal(save.disabled, true);
	assert.equal(textarea.readOnly, true);
	assert.deepEqual(saved, ["Edited"]);
	pending.resolve(false);
	await pending.promise;
	assert.equal(save.disabled, false);
	assert.equal(textarea.isConnected, true);
	assert.equal(textarea.value, "Edited");
	pending = Promise.withResolvers<boolean>();
	save.click();
	pending.reject(new Error("Save failed"));
	await pending.promise.catch(() => {});
	assert.equal(textarea.value, "Edited");
	assert.equal(host.querySelector('[role="alert"]')?.textContent, "Save failed");
	pending = Promise.withResolvers<boolean>();
	save.click();
	pending.resolve(true);
	await pending.promise;
	assert.equal(host.querySelector(".mur-editing"), null);
	assert.equal(textarea.isConnected, false);
});

test("a shared model can outlive its view and switch through snapshots", async (t) => {
	const conversation = new ConversationModel();
	conversation.setConversation({ id: "a", messages: [message("a")] });
	const { view, host, flush, frameCount } = setup(t, { conversation });
	flush();
	assert.equal(view.state.messages, conversation.state.messages);
	await setImmediate();
	assert.match(host.querySelector(".mur-block-text")!.textContent!, /a/);
	conversation.setConversation({ id: "b", messages: [message("b")] });
	conversation.setConversation({ id: "a", messages: [message("fresh")] });
	flush();
	assert.deepEqual(
		view.state.messages.map((item) => item.id),
		["fresh"],
	);
	view.destroy();
	conversation.apply({
		conversationId: "a",
		changes: [{ type: "text.append", messageId: "fresh", blockId: "fresh-text", delta: " continues" }],
	});
	assert.equal(frameCount(), 0);
	assert.equal(host.childElementCount, 0);
	const replacement = new ChatView({ container: host, conversation });
	flush();
	await setImmediate();
	assert.match(host.textContent!, /fresh continues/);
	replacement.destroy();
});

test("streaming past blocks without a renderer allocates no DOM nodes", async (t) => {
	const parse = t.mock.method(marked, "parse");
	const { view, host, flush } = setup(t, { stallDelay: 1000 });
	view.setConversation({
		id: "c",
		messages: [
			{
				id: "a",
				role: "assistant",
				status: "streaming",
				blocks: [
					{ id: "r", type: "reasoning", text: "Hidden" },
					{ id: "result", type: "tool_result", toolCallId: "call", outputText: "Hidden" },
					{ id: "artifact", type: "artifact", artifactId: "file", mime: "text/plain", content: "Hidden" },
					{ id: "text", type: "text", text: "Visible" },
					{ id: "progress", type: "custom", kind: "progress", data: null, fallbackText: "Working" },
				],
			},
		],
	});
	flush();
	const create = t.mock.method(document, "createElement");
	for (let i = 0; i < 10; i++) {
		view.apply({
			conversationId: "c",
			changes: [{ type: "text.append", messageId: "a", blockId: "text", delta: "." }],
		});
		flush();
	}
	assert.equal(create.mock.callCount(), 0);
	assert.equal(parse.mock.callCount(), 0, "a trailing progress block must not bypass the Markdown throttle");
	assert.equal(host.querySelectorAll(".mur-content-block").length, 2);
	view.apply({ conversationId: "c", changes: [{ type: "message.state", messageId: "a", status: "complete" }] });
	flush();
	await setImmediate();
	assert.equal(parse.mock.callCount(), 1);
	assert.equal(host.querySelector(".mur-block-text")!.textContent?.trim(), "Visible..........");
});

test("streaming activity replaces accessible dots without changing content or restarting Markdown", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const parse = t.mock.method(marked, "parse");
	const { view, host, flush } = setup(t, { labels: { responding: "Ответ готовится" } });
	view.setConversation({ id: "c", messages: [{ id: "a", role: "assistant", status: "streaming", blocks: [] }] });
	flush();
	const indicator = host.querySelector<HTMLElement>(".mur-message-loading[role=status]")!;
	assert.ok(indicator);
	assert.equal(indicator.textContent, "Ответ готовится");
	assert.equal(indicator.classList.contains("mur-loading-activity"), false);
	assert.ok(indicator.querySelector('.mur-loading-dot[aria-hidden="true"]'));
	view.apply({
		conversationId: "c",
		changes: [
			{ type: "block.put", messageId: "a", block: { id: "text", type: "text", text: "**Answer**" } },
			{ type: "message.state", messageId: "a", activity: "Reading <img src=x>" },
		],
	});
	await view.whenRendered();
	const content = host.querySelector("strong")!;
	assert.equal(content.textContent, "Answer");
	assert.equal(indicator.classList.contains("mur-loading-activity"), true);
	assert.equal(indicator.textContent, "Reading <img src=x>");
	assert.equal(indicator.querySelector("img"), null);
	view.apply({
		conversationId: "c",
		changes: [{ type: "message.state", messageId: "a", activity: "Searching", updatedAt: 100 }],
	});
	await view.whenRendered();
	assert.equal(indicator.textContent, "Searching");
	assert.equal(parse.mock.callCount(), 1);
	assert.equal(host.querySelector("strong"), content);
	view.apply({ conversationId: "c", changes: [{ type: "message.state", messageId: "a", activity: "" }] });
	flush();
	t.mock.timers.tick(60_000);
	// Clearing activity during streaming must not enable stall detection by default.
	assert.equal(host.querySelector(".mur-message-loading[role=status]"), null);
});

test("grouped runs retain empty streaming replies and their errors", (t) => {
	const { view, host, flush } = setup(t);
	view.setConversation({
		id: "c",
		messages: [
			{ ...message("u"), role: "user" },
			{
				id: "a",
				role: "assistant",
				blocks: [
					{ id: "call", type: "tool_call", toolCallId: "call", name: "search", argsText: "{}", status: "complete" },
					{ id: "last", type: "text", text: "Last" },
				],
			},
			{ id: "b", role: "assistant", status: "streaming", activity: "Thinking", blocks: [] },
		],
	});
	flush();
	assert.ok(host.querySelector(".mur-agent-run"));
	assert.equal(host.querySelectorAll(".mur-message-loading[role=status]").length, 1);
	assert.equal(host.querySelector(".mur-message-loading[role=status]")?.textContent, "Thinking");
	view.apply({
		conversationId: "c",
		changes: [{ type: "message.state", messageId: "b", status: "error", error: "Disconnected" }],
	});
	flush();
	assert.ok(host.querySelector(".mur-agent-run"));
	assert.equal(host.querySelector(".mur-message-loading[role=status]"), null);
	assert.match(host.querySelector(".mur-message-error")!.textContent!, /Disconnected/);
});

test("stall indicators follow visible output, ignore hidden reasoning and metadata, and yield to activity", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { view, host } = setup(t, { stallDelay: 1000, showReasoning: false, plugins: [ThinkingPlugin()] });
	const indicator = () => host.querySelector(".mur-message-loading[role=status]");
	view.setConversation({
		id: "c",
		messages: [
			{
				...message("a", "First"),
				status: "streaming",
				blocks: [
					{ id: "text", type: "text", text: "First" },
					{ id: "reason", type: "reasoning", text: "Hidden" },
				],
			},
		],
	});
	await view.whenRendered();
	t.mock.timers.tick(700);
	assert.equal(indicator(), null);
	view.apply({
		conversationId: "c",
		changes: [{ type: "text.append", messageId: "a", blockId: "text", delta: " continues" }],
	});
	await view.whenRendered();
	t.mock.timers.tick(700);
	assert.equal(indicator(), null);
	view.apply({
		conversationId: "c",
		changes: [
			{ type: "text.append", messageId: "a", blockId: "reason", delta: " thinking" },
			{ type: "message.state", messageId: "a", updatedAt: 42, usage: { input: 1, output: 2, total: 3 } },
		],
	});
	await view.whenRendered();
	t.mock.timers.tick(301);
	assert.ok(indicator());
	assert.equal(indicator()!.classList.contains("mur-loading-activity"), false);
	view.apply({ conversationId: "c", changes: [{ type: "message.state", messageId: "a", activity: "Searching" }] });
	await view.whenRendered();
	assert.equal(indicator()?.textContent, "Searching");
	view.apply({ conversationId: "c", changes: [{ type: "message.state", messageId: "a", activity: "" }] });
	await view.whenRendered();
	assert.ok(indicator(), "clearing activity reveals the existing stalled state");
	view.apply({
		conversationId: "c",
		changes: [{ type: "text.append", messageId: "a", blockId: "text", delta: " again" }],
	});
	await view.whenRendered();
	assert.equal(indicator(), null);
	view.apply({ conversationId: "c", changes: [{ type: "message.state", messageId: "a", activity: "Reading" }] });
	await view.whenRendered();
	assert.equal(indicator()?.textContent, "Reading", "explicit activity does not wait for a stall");
});

test("all chunks share a stall deadline and show one indicator after the final chunk", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { view, host } = setup(t, { stallDelay: 1000 });
	const indicators = () => host.querySelectorAll(".mur-message-loading[role=status]");
	view.setConversation({
		id: "c",
		messages: [
			{ ...message("u"), role: "user" },
			{
				id: "a",
				role: "assistant",
				status: "streaming",
				blocks: [
					{ id: "first", type: "text", text: "First" },
					{ id: "tool", type: "tool_call", toolCallId: "call", name: "search", argsText: "", status: "streaming" },
					{ id: "last", type: "text", text: "Last" },
					{ id: "hidden", type: "reasoning", text: "Not rendered without a plugin" },
				],
			},
		],
	});
	await view.whenRendered();
	assert.ok(host.querySelector(".mur-agent-run"));
	assert.equal(indicators().length, 0, "a trailing hidden chunk does not make the response look empty");
	t.mock.timers.tick(700);
	view.apply({
		conversationId: "c",
		changes: [{ type: "text.append", messageId: "a", blockId: "first", delta: " updated" }],
	});
	await view.whenRendered();
	t.mock.timers.tick(700);
	assert.equal(indicators().length, 0, "an earlier chunk resets the shared deadline");
	t.mock.timers.tick(301);
	assert.equal(indicators().length, 1);
	assert.ok(
		host.querySelector('[data-block-id="last"]')!.compareDocumentPosition(indicators()[0]) &
			Node.DOCUMENT_POSITION_FOLLOWING,
	);
	view.apply({
		conversationId: "c",
		changes: [{ type: "tool.update", messageId: "a", blockId: "tool", argsDelta: "{}" }],
	});
	await view.whenRendered();
	assert.equal(indicators().length, 1, "undisplayed tool arguments do not count as progress");
	view.apply({
		conversationId: "c",
		changes: [{ type: "tool.update", messageId: "a", blockId: "tool", status: "running" }],
	});
	await view.whenRendered();
	assert.equal(indicators().length, 0);
	t.mock.timers.tick(1001);
	assert.equal(indicators().length, 1);
	view.apply({ conversationId: "c", changes: [{ type: "block.remove", messageId: "a", blockId: "last" }] });
	await view.whenRendered();
	assert.equal(indicators().length, 0);
	t.mock.timers.tick(1001);
	assert.equal(indicators().length, 1);
	assert.ok(indicators()[0].parentElement?.querySelector('[data-block-id="tool"]'));
});

test("pending Markdown does not count as visible progress; its commit hides the stall indicator", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const parsed = Promise.withResolvers<string>();
	const { view, host, flush } = setup(t, {
		stallDelay: 1000,
		markdown: { parse: (text) => (text === "First" ? text : parsed.promise) },
	});
	view.setConversation({ id: "c", messages: [{ ...message("a", "First"), status: "streaming" }] });
	await view.whenRendered();
	t.mock.timers.tick(700);
	view.apply({
		conversationId: "c",
		changes: [{ type: "text.append", messageId: "a", blockId: "a-text", delta: " pending" }],
	});
	flush();
	t.mock.timers.tick(301);
	assert.ok(host.querySelector(".mur-message-loading[role=status]"));
	assert.equal(host.querySelector(".mur-block-text")?.textContent, "First");
	parsed.resolve("New content");
	await view.whenRendered();
	assert.equal(host.querySelector(".mur-message-loading[role=status]"), null);
	assert.equal(host.querySelector(".mur-block-text")?.textContent, "New content");
});

test("stall timers are released on completion, errors, removal, conversation switches, loading and destruction", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const scheduled = t.mock.method(globalThis, "setTimeout");
	const cancelled = t.mock.method(globalThis, "clearTimeout");
	const { view, host, flush } = setup(t, { stallDelay: 1000 });
	const stop = [
		() => view.apply({ conversationId: "c", changes: [{ type: "message.state", messageId: "a", status: "complete" }] }),
		() =>
			view.apply({ conversationId: "c", changes: [{ type: "message.state", messageId: "a", error: "Disconnected" }] }),
		() => view.apply({ conversationId: "c", changes: [{ type: "message.remove", messageId: "a" }] }),
		() => view.setConversation({ id: "other", messages: [] }),
		() => view.setLoading(true),
		() => view.destroy(),
	];
	for (const finish of stop) {
		view.setLoading(false);
		view.setConversation({ id: "c", messages: [{ ...message("a"), status: "streaming" }] });
		await view.whenRendered();
		const timer = scheduled.mock.calls.filter((call) => call.arguments[1] === 1000).at(-1)!.result;
		assert.ok(timer);
		finish();
		flush();
		assert.ok(
			cancelled.mock.calls.some((call) => call.arguments[0] === timer),
			"pending stall timeout was cancelled",
		);
		t.mock.timers.tick(2000);
		assert.equal(host.querySelector(".mur-message-loading[role=status]"), null);
	}
});

test("deltas coalesce into one update of the affected message, retaining other DOM", (t) => {
	const visits: string[] = [];
	const { view, host, flush } = setup(t, {
		plugins: [
			{
				name: "test-0",
				renderers: [
					{
						matches: (block) => block.type === "text",
						mount: (container) => ({
							update(block, ctx) {
								visits.push(ctx.message.id);
								if (block.type === "text") container.textContent = block.text;
							},
							destroy() {},
						}),
					},
				],
			},
		],
	});
	view.setConversation({ id: "c", messages: Array.from({ length: 100 }, (_, i) => message(String(i))) });
	flush();
	visits.length = 0;
	const first = host.querySelector('[data-block-id="0-text"]');
	for (const delta of ["A", "B", "C"])
		view.apply({ conversationId: "c", changes: [{ type: "text.append", messageId: "99", blockId: "99-text", delta }] });
	assert.equal(visits.length, 0);
	flush();
	assert.deepEqual(visits, ["99"]);
	assert.equal(host.querySelector('[data-block-id="0-text"]'), first);
	assert.equal(host.querySelector('[data-block-id="99-text"]')?.textContent, "99ABC");
});

test("card updates preserve context and focus, gate actions, and clean up on replacement/removal", (t) => {
	let mounts = 0;
	let destroys = 0;
	let context: RendererContext;
	const actions: BlockAction[] = [];
	const renderer: BlockRenderer = {
		matches: (block) => block.type === "custom" && block.kind === "form",
		mount(container) {
			mounts++;
			const input = document.createElement("input");
			container.append(input);
			return {
				update(_block, ctx) {
					context = ctx;
					input.disabled = !ctx.canAct;
				},
				destroy() {
					destroys++;
				},
			};
		},
	};
	const card = { id: "card", type: "custom" as const, kind: "form", data: { count: 1 }, fallbackText: "form" };
	const { view, host, flush } = setup(t, {
		showReasoning: false,
		onAction: (command) => {
			actions.push(command);
		},
		plugins: [{ name: "test-0", renderers: [renderer] }],
	});
	view.setConversation({
		id: "c",
		messages: [{ id: "m", role: "assistant", blocks: [{ id: "reason", type: "reasoning", text: "Hidden" }, card] }],
	});
	flush();
	const input = host.querySelector("input")!;
	input.focus();
	input.value = "unsent text";
	view.apply({
		conversationId: "c",
		changes: [
			{ type: "block.put", messageId: "m", block: { ...card, data: { count: 2 } } },
			{ type: "message.state", messageId: "m", usage: { input: 1, output: 2, total: 3 }, updatedAt: 123 },
		],
	});
	flush();
	assert.equal(context!.message.usage?.total, 3);
	assert.equal(context!.message.updatedAt, 123);
	assert.deepEqual(
		context!.message.blocks.map((block) => block.id),
		["card"],
	);
	assert.equal(document.activeElement, input);
	assert.equal(input.value, "unsent text");
	assert.equal(mounts, 1);
	context!.dispatch("confirm", { value: "yes" });
	assert.deepEqual(actions[0], {
		conversationId: "c",
		messageId: "m",
		blockId: "card",
		action: "confirm",
		payload: { value: "yes" },
	});
	view.setCanAct(false);
	flush();
	assert.equal(input.disabled, true);
	context!.dispatch("confirm");
	assert.equal(actions.length, 1);
	view.apply({
		conversationId: "c",
		changes: [{ type: "block.put", messageId: "m", block: { ...card, kind: "unknown" } }],
	});
	flush();
	assert.equal(destroys, 1);
	assert.equal(host.querySelector("input"), null);
	view.apply({ conversationId: "c", changes: [{ type: "block.put", messageId: "m", block: card }] });
	flush();
	view.apply({ conversationId: "c", changes: [{ type: "message.remove", messageId: "m" }] });
	flush();
	assert.equal(destroys, 2);
});

test("read-only capability updates existing actions while preserving non-mutating actions", (t) => {
	let copied = 0;
	let edited = 0;
	const { view, host, flush } = setup(t, {
		plugins: [
			{
				name: "actions",
				getActionButtons: () => [
					{
						id: "copy",
						title: "Copy",
						iconHtml: "Copy",
						mutates: false,
						onClick: () => {
							copied++;
						},
					},
					{
						id: "edit",
						title: "Edit",
						iconHtml: "Edit",
						onClick: () => {
							edited++;
						},
					},
				],
			},
		],
	});
	view.setConversation({ id: "c", messages: [message("a")] });
	flush();
	const copy = host.querySelector<HTMLButtonElement>('[data-action-id="copy"]')!;
	const edit = host.querySelector<HTMLButtonElement>('[data-action-id="edit"]')!;
	view.setCanAct(false);
	flush();
	assert.equal(copy.disabled, false);
	assert.equal(edit.disabled, true);
	copy.click();
	edit.click();
	assert.equal(copied, 1);
	assert.equal(edited, 0);
	view.setCanAct(true);
	flush();
	edit.click();
	assert.equal(edited, 1);
});

test("copy actions follow server block updates while preserving focus and click feedback", async (t) => {
	const { view, host, flush } = setup(t, { plugins: [CopyPlugin()] });
	const copied: string[] = [];
	t.mock.method(navigator.clipboard, "writeText", async (text: string) => {
		copied.push(text);
	});
	view.setConversation({
		id: "c",
		messages: [
			{
				id: "a",
				role: "assistant",
				blocks: [{ id: "card", type: "custom", kind: "task", data: {}, fallbackText: "Task" }],
			},
		],
	});
	flush();
	assert.equal(host.querySelector("[data-action-id='copy']"), null);
	view.apply({
		conversationId: "c",
		changes: [{ type: "block.put", messageId: "a", block: { id: "text", type: "text", text: "First" } }],
	});
	flush();
	const copy = host.querySelector<HTMLButtonElement>("[data-action-id='copy']")!;
	assert.ok(copy);
	copy.focus();
	copy.click();
	await Promise.resolve();
	const feedback = copy.innerHTML;
	const observer = new dom.window.MutationObserver(() => {});
	observer.observe(copy, { attributes: true, childList: true, subtree: true, characterData: true });
	view.apply({
		conversationId: "c",
		changes: [{ type: "block.put", messageId: "a", block: { id: "text", type: "text", text: "Second" } }],
	});
	flush();
	assert.equal(host.querySelector("[data-action-id='copy']"), copy);
	assert.equal(document.activeElement, copy);
	assert.equal(copy.innerHTML, feedback);
	assert.equal(observer.takeRecords().length, 0);
	observer.disconnect();
	copy.click();
	await Promise.resolve();
	assert.deepEqual(copied, ["First", "Second"]);
	view.apply({ conversationId: "c", changes: [{ type: "block.remove", messageId: "a", blockId: "text" }] });
	flush();
	assert.equal(host.querySelector("[data-action-id='copy']"), null);
	copy.click();
	assert.equal(copied.length, 2);
	view.apply({
		conversationId: "c",
		changes: [{ type: "block.put", messageId: "a", block: { id: "text", type: "text", text: "Restored" } }],
	});
	flush();
	const restored = host.querySelector<HTMLButtonElement>("[data-action-id='copy']")!;
	assert.ok(restored);
	assert.equal(restored.closest<HTMLElement>(".mur-message-actions")!.hidden, false);
	restored.click();
	await Promise.resolve();
	assert.deepEqual(copied, ["First", "Second", "Restored"]);
});

test("message actions reconcile order, definitions and permissions, deferring computation during streaming", (t) => {
	const clicked: string[] = [];
	const contexts: MessageActionContext[] = [];
	let evaluations = 0;
	const other: ActionButtonDef = { id: "other", title: "Other", iconHtml: "O", onClick: () => {} };
	const editable: ActionButtonDef = {
		id: "action",
		title: "First",
		iconHtml: "A",
		mutates: false,
		onClick: () => clicked.push("first"),
	};
	let definitions = [editable, other];
	const { view, host, flush } = setup(t, {
		plugins: [
			{
				name: "actions",
				getActionButtons: () => {
					evaluations++;
					return definitions;
				},
			},
		],
	});
	view.setCanAct(false);
	view.setConversation({ id: "c", messages: [{ ...message("a"), status: "streaming" }] });
	flush();
	assert.equal(evaluations, 0);
	assert.equal(host.querySelector(".mur-message-actions"), null);
	assert.equal(host.querySelector(".mur-chat-history")!.getAttribute("aria-busy"), "true");
	view.apply({ conversationId: "c", changes: [{ type: "message.state", messageId: "a", status: "complete" }] });
	flush();
	assert.equal(host.querySelector(".mur-chat-history")!.getAttribute("aria-busy"), "false");
	const button = host.querySelector<HTMLButtonElement>("[data-action-id='action']")!;
	button.focus();
	button.click();
	editable.title = "Second";
	editable.iconHtml = "B";
	editable.onClick = (context) => {
		clicked.push("second");
		contexts.push(context);
	};
	definitions = [other, editable];
	view.apply({
		conversationId: "c",
		changes: [{ type: "block.put", messageId: "a", block: { id: "a-text", type: "text", text: "Updated" } }],
	});
	flush();
	assert.deepEqual(
		[...host.querySelectorAll<HTMLElement>("[data-action-id]")].map((el) => el.dataset.actionId),
		["other", "action"],
	);
	assert.equal(host.querySelector("[data-action-id='action']"), button);
	assert.equal(button.title, "Second");
	assert.equal(button.innerHTML, "B");
	assert.equal(document.activeElement, button);
	button.click();
	assert.deepEqual(clicked, ["first", "second"]);
	assert.deepEqual(contexts[0].message.blocks, [{ id: "a-text", type: "text", text: "Updated" }]);
	assert.equal(contexts[0].buttonEl, button);
	assert.equal(contexts[0].messageEl, host.querySelector(".mur-message"));
	const beforeStream = evaluations;
	view.apply({ conversationId: "c", changes: [{ type: "message.state", messageId: "a", status: "streaming" }] });
	flush();
	for (let i = 0; i < 3; i++) {
		view.apply({
			conversationId: "c",
			changes: [{ type: "text.append", messageId: "a", blockId: "a-text", delta: " token" }],
		});
		flush();
	}
	assert.equal(evaluations, beforeStream);
	definitions = [{ ...editable, mutates: true }];
	view.apply({ conversationId: "c", changes: [{ type: "message.state", messageId: "a", status: "complete" }] });
	flush();
	assert.equal(evaluations, beforeStream + 1);
	assert.equal(host.querySelector("[data-action-id='other']"), null);
	assert.equal(button.disabled, true);
	button.click();
	assert.deepEqual(clicked, ["first", "second"]);
	view.setCanAct(true);
	flush();
	assert.equal(button.disabled, false);
	view.destroy();
	button.click();
	assert.deepEqual(clicked, ["first", "second"]);
});

test("ChatView reports unsupported composer hooks once, without warning for display plugins", (t) => {
	const warnings: string[] = [];
	t.mock.method(console, "warn", (message: string) => warnings.push(message));
	const { view, flush } = setup(t, { plugins: [AttachmentPlugin(), CopyPlugin(), ThinkingPlugin()] });
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /attachment.*mountComposer/);
	assert.match(warnings[0], /Only message display hooks/);
	view.setConversation({ id: "c", messages: [message("a")] });
	flush();
	view.apply({
		conversationId: "c",
		changes: [{ type: "text.append", messageId: "a", blockId: "a-text", delta: " more" }],
	});
	flush();
	assert.equal(warnings.length, 1);
});

test("summary tools keep folding but never render raw args/results or reasoning", (t) => {
	const { view, host, flush } = setup(t, {
		showReasoning: false,
		plugins: [ToolsPlugin({ details: false }), ThinkingPlugin()],
	});
	view.setConversation({
		id: "c",
		messages: [
			{ ...message("u"), role: "user" },
			{
				id: "step",
				role: "assistant",
				blocks: [
					{ id: "reason", type: "reasoning", text: "hidden reasoning" },
					{
						id: "tool",
						type: "tool_call",
						toolCallId: "call",
						name: "search",
						argsText: '{"secret":true}',
						summary: "Searched five sites",
						status: "complete",
					},
				],
			},
			{
				id: "result",
				role: "tool",
				blocks: [{ id: "result", type: "tool_result", toolCallId: "call", outputText: "secret result" }],
			},
			message("answer"),
		],
	});
	flush();
	const toggle = host.querySelector<HTMLButtonElement>(".mur-agent-run-summary")!;
	assert.ok(toggle);
	toggle.click();
	assert.match(host.textContent!, /Searched five sites/);
	assert.doesNotMatch(host.textContent!, /secret|hidden reasoning/);
	assert.equal(host.querySelector(".mur-tool-details"), null);
	assert.equal(host.querySelector<HTMLButtonElement>(".mur-tool-summary")!.disabled, true);
});

test("detailed tools show replaced results, including after an earlier result was cached", (t) => {
	const { view, host, flush } = setup(t, { plugins: [ToolsPlugin({ defaultExpanded: true }), ThinkingPlugin()] });
	const tool = {
		id: "tool",
		type: "tool_call" as const,
		toolCallId: "call",
		name: "read",
		argsText: '{"path":"a.txt"}',
		status: "running" as const,
	};
	const result = { id: "result", type: "tool_result" as const, toolCallId: "call", outputText: "first result" };
	view.setConversation({
		id: "c",
		messages: [
			{ id: "a", role: "assistant", blocks: [{ id: "reason", type: "reasoning", text: "Planning" }, tool] },
			{ id: "r", role: "tool", blocks: [result] },
		],
	});
	flush();
	assert.match(host.textContent!, /first result/);
	assert.match(host.textContent!, /a.txt/);
	assert.ok(host.querySelector(".mur-think-wrapper"));
	view.apply({
		conversationId: "c",
		changes: [{ type: "block.put", messageId: "r", block: { ...result, outputText: "replacement result" } }],
	});
	flush();
	assert.match(host.textContent!, /replacement result/);
	assert.doesNotMatch(host.textContent!, /first result/);
	view.apply({ conversationId: "c", changes: [{ type: "message.remove", messageId: "r" }] });
	flush();
	assert.doesNotMatch(host.textContent!, /replacement result/);
});

test("late Markdown highlighting cannot replace newer text", async (t) => {
	const oldHighlight = Promise.withResolvers<string>();
	const decorated: string[] = [];
	const { view, host, flush } = setup(t, {
		highlighter: () => oldHighlight.promise,
		markdown: {
			decorate: (root) => {
				decorated.push(root.textContent!.trim());
			},
		},
	});
	view.setConversation({ id: "c", messages: [message("a", "```ts\nold\n```")] });
	flush();
	await setImmediate();
	const rendered = Promise.all([view.whenRendered(), view.whenRendered()]);
	view.apply({
		conversationId: "c",
		changes: [{ type: "block.put", messageId: "a", block: { id: "a-text", type: "text", text: "**new**" } }],
	});
	flush();
	await rendered;
	oldHighlight.resolve("stale result");
	await setImmediate();
	assert.deepEqual(decorated, ["new"], "superseded highlighting must not start expensive decoration");
	assert.equal(host.querySelector("strong")?.textContent, "new");
	assert.doesNotMatch(host.querySelector(".mur-chat-history")!.textContent!, /old|stale/);
});

test("Markdown decoration follows whole-message streaming and waits for the final pass only", async (t) => {
	const streamed = Promise.withResolvers<void>();
	const completed = Promise.withResolvers<void>();
	const parses: string[] = [];
	const phases: boolean[] = [];
	const { view, host, flush } = setup(t, {
		markdown: {
			parse(text, message) {
				parses.push(message.id);
				return `<p>${text}</p>`;
			},
			async decorate(root, { message, streaming }) {
				if (message.id !== "a") return;
				phases.push(streaming);
				await (streaming ? streamed.promise : completed.promise);
				root.querySelector("p")!.setAttribute("data-phase", streaming ? "streaming" : "complete");
			},
		},
	});
	view.setConversation({
		id: "c",
		messages: [
			message("history"),
			{
				...message("a", "Answer"),
				status: "streaming",
				blocks: [
					{ id: "a-text", type: "text", text: "Answer" },
					{ id: "progress", type: "custom", kind: "progress", data: null, fallbackText: "Working" },
				],
			},
		],
	});
	let ready = false;
	const rendered = view.whenRendered().then(() => {
		ready = true;
	});
	await setImmediate();
	assert.equal(ready, false);
	assert.deepEqual(phases, [true], "a trailing progress block does not finish the message");
	const history = host.querySelector('[data-block-id="history-text"] p');
	view.apply({ conversationId: "c", changes: [{ type: "message.state", messageId: "a", status: "complete" }] });
	flush();
	await setImmediate();
	assert.equal(ready, false);
	assert.deepEqual(phases, [true, false]);
	completed.resolve();
	await rendered;
	assert.equal(host.querySelector('[data-block-id="a-text"] p')?.getAttribute("data-phase"), "complete");
	streamed.resolve();
	await setImmediate();
	view.apply({
		conversationId: "c",
		changes: [{ type: "message.state", messageId: "a", status: "complete", usage: { input: 1, output: 2, total: 3 } }],
	});
	await view.whenRendered();
	assert.deepEqual(parses, ["history", "a", "a"]);
	assert.deepEqual(phases, [true, false]);
	assert.equal(host.querySelector('[data-block-id="history-text"] p'), history);
	assert.equal(host.querySelector('[data-block-id="a-text"] p')?.getAttribute("data-phase"), "complete");
});

test("growing text hides its unfinished tail and renders unchanged once it stops", async (t) => {
	const { view, host, flush } = setup(t);
	const text = "See **the [docs](https://exa";
	view.setConversation({ id: "c", messages: [{ ...message("a", text), status: "streaming" }] });
	flush();
	await view.whenRendered();
	const block = host.querySelector('[data-block-id="a-text"]')!;
	const link = block.querySelector("strong > a")!;
	assert.equal(link.textContent, "docs");
	assert.equal(link.hasAttribute("href"), false);
	assert.equal(link.hasAttribute("data-incomplete"), true);
	// Completion changes no text, yet the tail must render as received.
	view.apply({ conversationId: "c", changes: [{ type: "message.state", messageId: "a", status: "complete" }] });
	flush();
	await view.whenRendered();
	assert.equal(block.querySelector("p")?.textContent, text);
	assert.equal(block.querySelector("strong, [data-incomplete]"), null);
});

test("hidden syntax arriving in growing text does not rerun Markdown hooks", async (t) => {
	const parsed: string[] = [];
	const { view, flush } = setup(t, {
		markdown: {
			parse(text) {
				parsed.push(text);
				return `<p>${text}</p>`;
			},
		},
	});
	view.setConversation({ id: "c", messages: [{ ...message("a", "See ![chart](https://ex"), status: "streaming" }] });
	flush();
	await view.whenRendered();
	for (const delta of ["ample.com/", "chart.png"]) {
		view.apply({ conversationId: "c", changes: [{ type: "text.append", messageId: "a", blockId: "a-text", delta }] });
		flush();
		await view.whenRendered();
	}
	assert.deepEqual(parsed, ["See "]);
});

test("a failed render is retried even when the adjusted text is unchanged", async (t) => {
	t.mock.method(console, "error", () => {});
	let failures = 1;
	const { view, host, flush } = setup(t, {
		markdown: {
			parse(text) {
				if (failures-- > 0) throw new Error("parse failed");
				return marked.parse(text);
			},
		},
	});
	view.setConversation({ id: "c", messages: [{ ...message("a", "Answer: **bold"), status: "streaming" }] });
	flush();
	await view.whenRendered();
	assert.equal(host.querySelector('[data-block-id="a-text"]')?.textContent, "Answer: **bold");
	// The closing marker leaves the adjusted text as it was.
	view.apply({
		conversationId: "c",
		changes: [{ type: "text.append", messageId: "a", blockId: "a-text", delta: "**" }],
	});
	flush();
	await view.whenRendered();
	assert.equal(host.querySelector('[data-block-id="a-text"] strong')?.textContent, "bold");
});

test("growing text highlights unchanged code once and everything again once it stops", async (t) => {
	for (const smoothStreaming of [true, false]) {
		await t.test(`smoothStreaming: ${smoothStreaming}`, async (t) => {
			const highlighted: string[] = [];
			const { view, host, flush } = setup(t, {
				highlighter: async (code, lang) => {
					highlighted.push(`${lang}:${code.trim()}`);
					return `<span class="hl">${code}</span>`;
				},
				markdown: { smoothStreaming },
			});
			view.setConversation({ id: "c", messages: [{ ...message("a", "```js\na\n```\n\nNext"), status: "streaming" }] });
			flush();
			await view.whenRendered();
			for (const delta of [" step", "\n\n```py\nb", "c"]) {
				view.apply({
					conversationId: "c",
					changes: [{ type: "text.append", messageId: "a", blockId: "a-text", delta }],
				});
				flush();
				await view.whenRendered();
			}
			assert.deepEqual(highlighted, ["js:a", "py:b", "py:bc"]);
			assert.equal(host.querySelectorAll("code .hl").length, 2);
			view.apply({ conversationId: "c", changes: [{ type: "message.state", messageId: "a", status: "complete" }] });
			flush();
			await view.whenRendered();
			assert.deepEqual(highlighted.slice(3), ["js:a", "py:bc"]);
			assert.equal(host.querySelectorAll("code .hl").length, 2);
		});
	}
});

test("late Markdown hooks cannot revive replaced or removed content, or hold rendering waits", async (t) => {
	for (const stage of ["parse", "decorate"] as const) {
		await t.test(stage, async (t) => {
			const gates = new Map(["old", "removed", "destroyed"].map((text) => [text, Promise.withResolvers<void>()]));
			const { view, host, flush } = setup(t, {
				markdown: {
					async parse(text) {
						if (stage === "parse") await gates.get(text)?.promise;
						return `<p>${text}</p>`;
					},
					async decorate(root) {
						if (stage === "decorate") await gates.get(root.textContent!)?.promise;
						root.append(" decorated");
					},
				},
			});
			view.setConversation({ id: "c", messages: [message("a", "old")] });
			const waiting = view.whenRendered();
			await setImmediate();
			view.apply({
				conversationId: "c",
				changes: [{ type: "block.put", messageId: "a", block: { id: "a-text", type: "text", text: "new" } }],
			});
			flush();
			await waiting;
			gates.get("old")!.resolve();
			await setImmediate();
			assert.equal(host.querySelector(".mur-block-text")?.textContent, "new decorated");
			for (const text of ["removed", "destroyed"]) {
				view.apply({
					conversationId: "c",
					changes: [{ type: "block.put", messageId: "a", block: { id: "a-text", type: "text", text } }],
				});
				const pending = view.whenRendered();
				await setImmediate();
				const detached = host.querySelector(".mur-block-text")!;
				const before = detached.innerHTML;
				if (text === "destroyed") view.destroy();
				else {
					view.apply({ conversationId: "c", changes: [{ type: "block.remove", messageId: "a", blockId: "a-text" }] });
					flush();
				}
				await pending;
				gates.get(text)!.resolve();
				await setImmediate();
				assert.equal(host.querySelector(".mur-block-text"), null);
				assert.equal(detached.innerHTML, before);
			}
		});
	}
});

test("rendering waits include grouped text and release work when its segment is collapsed", async (t) => {
	const answer = Promise.withResolvers<void>();
	const hidden = Promise.withResolvers<void>();
	const rendered: string[] = [];
	const { view, host } = setup(t, {
		agentRunCollapse: "full",
		markdown: {
			async decorate(_root, { message }) {
				rendered.push(message.id);
				if (message.id === "answer") await answer.promise;
				if (message.id === "step") await hidden.promise;
			},
		},
	});
	view.setConversation({
		id: "c",
		messages: [{ ...message("question"), role: "user" }, message("step"), message("answer")],
	});
	const initial = view.whenRendered();
	await setImmediate();
	assert.deepEqual(rendered, ["question", "answer"]);
	assert.equal(host.querySelector('[data-block-id="answer-text"]')?.textContent, "");
	answer.resolve();
	await initial;
	assert.equal(host.querySelector('[data-block-id="answer-text"]')?.textContent?.trim(), "answer");
	const toggle = host.querySelector<HTMLButtonElement>(".mur-agent-run-summary")!;
	toggle.click();
	const expanded = view.whenRendered();
	await setImmediate();
	assert.deepEqual(rendered, ["question", "answer", "step"]);
	toggle.click();
	await expanded;
	hidden.resolve();
	await setImmediate();
	assert.equal(host.querySelector('[data-block-id="step-text"]'), null);
});

test("block replacements update only their message", (t) => {
	const visits: string[] = [];
	const { view, flush, frameCount } = setup(t, {
		plugins: [
			{
				name: "test-0",
				renderers: [
					{
						matches: () => true,
						mount: () => ({
							update(_block, ctx) {
								visits.push(ctx.message.id);
							},
							destroy() {},
						}),
					},
				],
			},
		],
	});
	const card: ContentBlock = { id: "card", type: "custom", kind: "card", data: 0, fallbackText: "card" };
	const tool: ContentBlock = {
		id: "tool",
		type: "tool_call",
		toolCallId: "call",
		name: "search",
		argsText: "{}",
		status: "running",
	};
	view.setConversation({
		id: "c",
		messages: [
			...Array.from({ length: 100 }, (_, i) => message(String(i))),
			{ id: "target", role: "assistant", blocks: [card, tool] },
		],
	});
	flush();
	flush();
	visits.length = 0;
	view.apply({
		conversationId: "c",
		changes: [
			{ type: "block.put", messageId: "target", block: { ...card, data: 1 } },
			{ type: "block.put", messageId: "target", block: { ...tool, argsText: '{"query":"new"}' } },
		],
	});
	flush();
	flush();
	assert.deepEqual(visits, ["target", "target"]);
	assert.equal(frameCount(), 0);
});

test("grouped message updates preserve the card's current context and input", (t) => {
	let mounts = 0;
	let context: RendererContext;
	const { view, host, flush } = setup(t, {
		agentRunCollapse: "full",
		plugins: [
			{
				name: "test-0",
				renderers: [
					{
						matches: (block) => block.type === "custom",
						mount(container) {
							mounts++;
							container.append(document.createElement("input"));
							return {
								update(_block, ctx) {
									context = ctx;
								},
								destroy() {},
							};
						},
					},
				],
			},
		],
	});
	view.setConversation({
		id: "c",
		messages: [
			{ ...message("u"), role: "user" },
			{
				id: "answer",
				role: "assistant",
				blocks: [
					{ id: "tool", type: "tool_call", toolCallId: "call", name: "read", argsText: "{}", status: "complete" },
					{ id: "card", type: "custom", kind: "form", data: {}, fallbackText: "form" },
				],
			},
		],
	});
	flush();
	assert.ok(host.querySelector(".mur-agent-run"));
	const input = host.querySelector("input")!;
	input.focus();
	input.value = "keep me";
	view.apply({
		conversationId: "c",
		changes: [{ type: "message.state", messageId: "answer", usage: { input: 1, output: 2, total: 3 }, updatedAt: 123 }],
	});
	flush();
	assert.equal(context!.message.usage?.total, 3);
	assert.equal(context!.message.updatedAt, 123);
	assert.deepEqual(
		context!.message.blocks.map((block) => block.id),
		["card"],
	);
	assert.equal(host.querySelector("input"), input);
	assert.equal(document.activeElement, input);
	assert.equal(input.value, "keep me");
	assert.equal(mounts, 1);
	view.apply({
		conversationId: "c",
		changes: [
			{ type: "block.put", messageId: "answer", block: { id: "additional", type: "text", text: "Another block" } },
		],
	});
	flush();
	assert.equal(host.querySelector("input"), input);
	assert.equal(document.activeElement, input);
	assert.equal(input.value, "keep me");
	assert.equal(mounts, 1);
});

test("streaming and late metadata update only the affected message in a run", (t) => {
	const visits: string[] = [];
	let currentMessage: Message;
	const { view, host, flush } = setup(t, {
		plugins: [
			{
				name: "test-0",
				renderers: [
					{
						matches: () => true,
						mount: (container) => ({
							update(block, ctx) {
								visits.push(ctx.message.id);
								currentMessage = ctx.message;
								if (block.type === "text") container.textContent = block.text;
							},
							destroy() {},
						}),
					},
				],
			},
		],
	});
	view.setConversation({
		id: "c",
		messages: [
			{ ...message("u"), role: "user" },
			{
				id: "tools",
				role: "assistant",
				blocks: [
					{ id: "tool", type: "tool_call", toolCallId: "call", name: "read", argsText: "{}", status: "complete" },
				],
			},
			message("intermediate"),
			{ ...message("answer"), status: "streaming" },
		],
	});
	flush();
	assert.ok(host.querySelector(".mur-agent-run"));
	visits.length = 0;
	const answer = host.querySelector('[data-block-id="answer-text"]')!;
	const observer = new dom.window.MutationObserver(() => {});
	observer.observe(host, { subtree: true, attributes: true, childList: true, characterData: true });
	view.apply({
		conversationId: "c",
		changes: [{ type: "text.append", messageId: "answer", blockId: "answer-text", delta: " continues" }],
	});
	flush();
	assert.deepEqual(visits, ["answer"]);
	assert.equal(host.querySelector('[data-block-id="answer-text"]')?.textContent, "answer continues");
	assert.ok(observer.takeRecords().every((record) => answer.contains(record.target)));
	observer.disconnect();
	view.apply({ conversationId: "c", changes: [{ type: "message.state", messageId: "answer", status: "complete" }] });
	flush();
	visits.length = 0;
	view.apply({
		conversationId: "c",
		changes: [{ type: "message.state", messageId: "answer", usage: { input: 1, output: 2, total: 3 }, updatedAt: 123 }],
	});
	flush();
	assert.deepEqual(visits, ["answer"]);
	assert.equal(currentMessage!.usage?.total, 3);
	assert.equal(currentMessage!.updatedAt, 123);
});

test("destroyed card contexts cannot dispatch after the same block id is mounted again", (t) => {
	const contexts: RendererContext[] = [];
	const actions: BlockAction[] = [];
	const { view, flush } = setup(t, {
		onAction: (command) => {
			actions.push(command);
		},
		plugins: [
			{
				name: "test-0",
				renderers: [
					{
						matches: () => true,
						mount: () => ({
							update(_block, ctx) {
								contexts.push(ctx);
							},
							destroy() {
								contexts[0].dispatch("during-destroy");
							},
						}),
					},
				],
			},
		],
	});
	const card: ContentBlock = { id: "card", type: "custom", kind: "form", data: {}, fallbackText: "form" };
	view.setConversation({ id: "c", messages: [{ id: "a", role: "assistant", blocks: [card] }] });
	flush();
	view.apply({ conversationId: "c", changes: [{ type: "block.remove", messageId: "a", blockId: "card" }] });
	flush();
	view.apply({ conversationId: "c", changes: [{ type: "block.put", messageId: "a", block: card }] });
	flush();
	contexts[0].dispatch("late-result");
	assert.equal(actions.length, 0);
	contexts[1].dispatch("current");
	assert.equal(actions.length, 1);
});

test("text switches between built-in Markdown and a custom renderer without stale writes", async (t) => {
	const highlighting = Promise.withResolvers<string>();
	let highlightCalls = 0;
	let destroyCalls = 0;
	const { view, host, flush } = setup(t, {
		highlighter: () => {
			highlightCalls++;
			return highlighting.promise;
		},
		plugins: [
			{
				name: "takeover",
				renderers: [
					{
						matches: (block, message) => block.type === "text" && message.role === "user",
						mount: (container) => ({
							update() {
								container.textContent = "Plugin owns this block";
							},
							destroy() {
								destroyCalls++;
								container.replaceChildren();
							},
						}),
					},
				],
			},
		],
	});
	view.setConversation({ id: "c", messages: [message("a", "```ts\nold\n```")] });
	flush();
	await setImmediate();
	assert.equal(highlightCalls, 1);
	view.apply({
		conversationId: "c",
		changes: [{ type: "message.put", message: { ...message("a", "```ts\nold\n```"), role: "user" } }],
	});
	flush();
	highlighting.resolve("old highlighting");
	await setImmediate();
	assert.equal(host.querySelector(".mur-block-text")?.textContent, "Plugin owns this block");
	assert.equal(highlightCalls, 1);

	view.apply({
		conversationId: "c",
		changes: [{ type: "message.put", message: message("a", "**Back**") }],
	});
	flush();
	await setImmediate();
	assert.equal(destroyCalls, 1);
	assert.equal(host.querySelector(".mur-block-text strong")?.textContent, "Back");
});

test("renderer cleanup that clears its container runs before the new owner writes", (t) => {
	let claims = true;
	const order: string[] = [];
	const { view, host, flush } = setup(t, {
		plugins: [
			{
				name: "test-0",
				renderers: [
					{
						matches: () => claims,
						mount: (container) => ({
							update() {
								container.textContent = "old";
							},
							destroy() {
								order.push("destroy");
								container.replaceChildren();
							},
						}),
					},
				],
			},
			{
				name: "new-owner",
				renderers: [
					{
						matches: () => !claims,
						mount: (container) => ({
							update() {
								order.push("update");
								container.textContent = "new";
							},
							destroy() {},
						}),
					},
				],
			},
		],
	});
	view.setConversation({ id: "c", messages: [message("a")] });
	flush();
	claims = false;
	view.apply({
		conversationId: "c",
		changes: [{ type: "text.append", messageId: "a", blockId: "a-text", delta: "x" }],
	});
	flush();
	assert.deepEqual(order, ["destroy", "update"]);
	assert.equal(host.querySelector(".mur-block-text")!.textContent, "new");
});

test("built-in reasoning renderers release handlers and scheduled measurement on removal", (t) => {
	const { view, host, flush, frameCount } = setup(t, { plugins: [agentThinking()] });
	view.setConversation({
		id: "c",
		messages: [{ id: "a", role: "assistant", blocks: [{ id: "r", type: "reasoning", text: "Short" }] }],
	});
	flush();
	const preview = host.querySelector<HTMLElement>(".mur-agent-think-preview")!;
	assert.ok(preview);
	view.destroy();
	assert.equal(preview.onclick, null);
	assert.equal(preview.onkeydown, null);
	assert.equal(frameCount(), 0);
});

test("labels reach transcript, actions and Markdown; optional empty content follows snapshots and loading", async (t) => {
	const { view, host, flush } = setup(t, {
		emptyState: "Пусто <script>",
		labels: {
			assistant: "Ассистент",
			copyCode: "Код",
			copyMessage: "Сообщение",
			loadingOlder: "История",
			stop: "Остановить",
		},
		plugins: [CopyPlugin()],
	});
	view.setConversation({ id: "c", messages: [] });
	view.setOlderMessagesState(true, false);
	flush();
	const empty = host.querySelector<HTMLElement>(".mur-view-empty")!;
	assert.equal(empty.hidden, false);
	assert.equal(host.querySelector("script"), null);
	view.setLoading(true);
	flush();
	assert.equal(empty.hidden, true);
	assert.equal(host.querySelector<HTMLElement>(".mur-feed-spinner:not(.mur-feed-spinner-top)")!.hidden, false);
	view.setLoading(false);
	flush();
	assert.equal(empty.hidden, false);
	view.setConversation({
		id: "c",
		messages: [message("a", "```ts\nx\n```")],
	});
	flush();
	await setImmediate();
	assert.equal(empty.hidden, true);
	assert.equal(host.querySelector("[role=article]")!.getAttribute("aria-label"), "Ассистент");
	assert.equal(host.querySelector(".mur-code-copy-btn")!.getAttribute("aria-label"), "Код");
	assert.equal(host.querySelector<HTMLButtonElement>('[data-action-id="copy"]')!.title, "Сообщение");
	assert.match(host.querySelector(".mur-feed-older-status")!.textContent!, /История/);
});
