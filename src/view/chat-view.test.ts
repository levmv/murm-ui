import assert from "node:assert/strict";
import { after, type TestContext, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { JSDOM } from "jsdom";
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
	flush();
	await setImmediate();
	assert.equal(host.querySelector("textarea"), null);
	assert.equal(host.querySelector("script, img"), null);
	assert.equal(host.querySelector("strong")?.textContent, "formatted");
	assert.match(host.textContent!, /<img/);
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
	const { view, host, flush } = setup(t);
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
	assert.equal(host.querySelectorAll(".mur-content-block").length, 1);
	view.apply({ conversationId: "c", changes: [{ type: "message.state", messageId: "a", status: "complete" }] });
	flush();
	await setImmediate();
	assert.equal(host.querySelector(".mur-block-text")!.textContent?.trim(), "Visible..........");
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
	const { view, host, flush } = setup(t, {
		highlighter: () => oldHighlight.promise,
	});
	view.setConversation({ id: "c", messages: [message("a", "```ts\nold\n```")] });
	flush();
	await setImmediate();
	view.apply({
		conversationId: "c",
		changes: [{ type: "block.put", messageId: "a", block: { id: "a-text", type: "text", text: "**new**" } }],
	});
	flush();
	await setImmediate();
	oldHighlight.resolve("stale result");
	await setImmediate();
	assert.equal(host.querySelector("strong")?.textContent, "new");
	assert.doesNotMatch(host.querySelector(".mur-chat-history")!.textContent!, /old|stale/);
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
	let takeover = false;
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
						matches: () => takeover,
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
	takeover = true;
	view.apply({
		conversationId: "c",
		changes: [{ type: "text.append", messageId: "a", blockId: "a-text", delta: "\n" }],
	});
	flush();
	highlighting.resolve("old highlighting");
	await setImmediate();
	assert.equal(host.querySelector(".mur-block-text")?.textContent, "Plugin owns this block");
	assert.equal(highlightCalls, 1);

	takeover = false;
	view.apply({
		conversationId: "c",
		changes: [{ type: "block.put", messageId: "a", block: { id: "a-text", type: "text", text: "**Back**" } }],
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

test("labels reach transcript, actions and Markdown; optional empty content follows snapshots", async (t) => {
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
	assert.equal(host.querySelector<HTMLElement>(".mur-view-empty")!.hidden, false);
	assert.equal(host.querySelector("script"), null);
	view.setConversation({
		id: "c",
		messages: [message("a", "```ts\nx\n```")],
	});
	flush();
	await setImmediate();
	assert.equal(host.querySelector<HTMLElement>(".mur-view-empty")!.hidden, true);
	assert.equal(host.querySelector("[role=article]")!.getAttribute("aria-label"), "Ассистент");
	assert.equal(host.querySelector(".mur-code-copy-btn")!.getAttribute("aria-label"), "Код");
	assert.equal(host.querySelector<HTMLButtonElement>('[data-action-id="copy"]')!.title, "Сообщение");
	assert.match(host.querySelector(".mur-feed-older-status")!.textContent!, /История/);
});
