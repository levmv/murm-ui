import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { ContentBlock, Message, RendererContext } from "../../core/types";
import { ToolsPlugin } from "./tools-plugin";

function setGlobal(name: string, value: unknown): void {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
		writable: true,
	});
}

function installDom(): void {
	const dom = new JSDOM("");
	setGlobal("document", dom.window.document);
	setGlobal("HTMLElement", dom.window.HTMLElement);
}

function toolMessages(status: "streaming" | "pending" | "running" | "complete" | "error" = "complete"): Message[] {
	return [
		{
			id: "assistant-1",
			role: "assistant",
			blocks: [
				{
					id: "tool-block-1",
					type: "tool_call",
					toolCallId: "call-1",
					name: "list_files",
					argsText: '{"path":"agent-experiment"}',
					status,
				},
			],
		},
		{
			id: "tool-result-1",
			role: "tool",
			blocks: [
				{
					id: "result-block-1",
					type: "tool_result",
					toolCallId: "call-1",
					outputText: "file agent-experiment/app.ts\nfile agent-experiment/package.json",
				},
			],
		},
	];
}

function renderContext(messages: Message[], isGenerating = false): RendererContext {
	return {
		message: messages[0],
		messages,
		blockIndex: 0,
		isGenerating,
		canAct: true,
		dispatch() {},
	};
}

test("ToolsPlugin renders a compact tool call and expands matching result", () => {
	installDom();
	const plugin = ToolsPlugin();
	const container = document.createElement("div");
	const renderer = plugin.renderers![0].mount(container);
	const messages = toolMessages();
	const toolCall = messages[0].blocks[0] as Extract<ContentBlock, { type: "tool_call" }>;

	renderer.update(toolCall, renderContext(messages, false));

	const title = container.querySelector(".mur-tool-title");
	const status = container.querySelector(".mur-tool-status");
	assert.equal(title?.textContent, "list_files agent-experiment");
	assert.equal(status?.textContent, "✓");
	assert.equal(status?.getAttribute("title"), "complete");
	assert.equal(container.querySelector(".mur-tool-details"), null);
	assert.equal(container.querySelector(".mur-tool-preview"), null);
	assert.equal(container.querySelectorAll(".mur-tool-section").length, 0);
	assert.doesNotMatch(container.textContent ?? "", /agent-experiment\/app\.ts/);

	container.querySelector<HTMLButtonElement>(".mur-tool-summary")?.click();

	const details = container.querySelector<HTMLElement>(".mur-tool-details");
	const preBlocks = container.querySelectorAll(".mur-tool-pre");
	const resultSection = container.querySelectorAll<HTMLElement>(".mur-tool-section")[1];
	assert.equal(details?.hidden, false);
	assert.equal(resultSection?.hidden, false);
	assert.match(preBlocks[1]?.textContent ?? "", /agent-experiment\/app\.ts/);

	container.querySelector<HTMLButtonElement>(".mur-tool-summary")?.click();
	assert.equal(container.querySelector(".mur-tool-details"), null);
	assert.equal(container.querySelectorAll(".mur-tool-section").length, 0);
	assert.doesNotMatch(container.textContent ?? "", /agent-experiment\/app\.ts/);
});

test("ToolsPlugin lets callers customize labels and result formatting", () => {
	installDom();
	const plugin = ToolsPlugin({
		defaultExpanded: true,
		tools: {
			list_files: {
				label: ({ args }) => `ls ${(args as { path: string }).path}`,
				formatResult: ({ outputText }) => outputText.split("\n").join(" | "),
			},
		},
	});
	const container = document.createElement("div");
	const renderer = plugin.renderers![0].mount(container);
	const messages = toolMessages();
	const toolCall = messages[0].blocks[0] as Extract<ContentBlock, { type: "tool_call" }>;

	renderer.update(toolCall, renderContext(messages, false));

	assert.equal(container.querySelector(".mur-tool-title")?.textContent, "ls agent-experiment");
	assert.equal(container.querySelector<HTMLElement>(".mur-tool-details")?.hidden, false);
	assert.match(container.textContent ?? "", /app\.ts \| file/);
});

test("ToolsPlugin caches missing results during streaming and refreshes when a result arrives", () => {
	installDom();
	const plugin = ToolsPlugin();
	const container = document.createElement("div");
	const renderer = plugin.renderers![0].mount(container);
	const messages = toolMessages("running");
	const toolCall = messages[0].blocks[0] as Extract<ContentBlock, { type: "tool_call" }>;
	messages.splice(1);
	const nextCall = { ...toolCall, id: "tool-block-2", toolCallId: "call-2" };
	messages.push({ id: "assistant-2", role: "assistant", blocks: [nextCall] });
	let historyReads = 0;
	const context = renderContext(messages, true);
	context.messages = new Proxy(messages, {
		get(target, key, receiver) {
			if (typeof key === "string" && /^\d+$/.test(key)) historyReads++;
			return Reflect.get(target, key, receiver);
		},
	});

	renderer.update(toolCall, context);
	assert.equal(container.querySelector(".mur-tool-status")?.textContent, "...");
	assert.ok(historyReads > 0);
	historyReads = 0;
	const nextRenderer = plugin.renderers![0].mount(document.createElement("div"));
	nextRenderer.update(nextCall, { ...context, message: messages[1] });
	assert.equal(historyReads, 0, "cards share a single transcript scan");
	nextRenderer.destroy();
	for (let i = 0; i < 10; i++) {
		toolCall.argsText += " ";
		renderer.update(toolCall, context);
	}
	assert.equal(historyReads, 0, "argument deltas must not scan the transcript for a missing result");

	toolCall.status = "complete";
	const withResult = [...messages, toolMessages()[1]];

	renderer.update(toolCall, renderContext(withResult, false));
	assert.equal(container.querySelector(".mur-tool-status")?.textContent, "✓");
	container.querySelector<HTMLButtonElement>(".mur-tool-summary")?.click();
	assert.equal(container.querySelectorAll<HTMLElement>(".mur-tool-section")[1]?.hidden, false);
	assert.match(container.textContent ?? "", /package\.json/);
});

test("ToolsPlugin invalidates a cached result when the transcript changes", () => {
	installDom();
	const plugin = ToolsPlugin({ defaultExpanded: true });
	const container = document.createElement("div");
	const renderer = plugin.renderers![0].mount(container);
	const messages = toolMessages();
	const toolCall = messages[0].blocks[0] as Extract<ContentBlock, { type: "tool_call" }>;
	const earlierMessages = toolMessages().map((message) => ({ ...message, id: `earlier-${message.id}` }));
	const context = { ...renderContext(messages, false), messages: [...earlierMessages, ...messages] };

	renderer.update(toolCall, context);
	assert.match(container.textContent ?? "", /agent-experiment\/app\.ts/);

	// Providers may reuse call IDs across turns. An earlier result is no match.
	const messagesWithoutResult = [...earlierMessages, messages[0]];
	renderer.update(toolCall, { ...context, messages: messagesWithoutResult });

	assert.doesNotMatch(container.textContent ?? "", /agent-experiment\/app\.ts/);
	assert.match(container.textContent ?? "", /No result\./);
});

test("unchanged tool renders do not mutate collapsed, expanded or summary DOM", () => {
	installDom();
	for (const config of [{}, { defaultExpanded: true }, { details: false }]) {
		const plugin = ToolsPlugin(config);
		const container = document.createElement("div");
		const renderer = plugin.renderers![0].mount(container);
		const messages = toolMessages();
		renderer.update(messages[0].blocks[0], renderContext(messages, false));
		const observer = new document.defaultView!.MutationObserver(() => {});
		observer.observe(container, { subtree: true, childList: true, attributes: true, characterData: true });
		renderer.update(messages[0].blocks[0], renderContext(messages, false));
		assert.equal(observer.takeRecords().length, 0);
		observer.disconnect();
	}
});

test("ToolsPlugin summarizes multiple important args without letting long values dominate", () => {
	installDom();
	const plugin = ToolsPlugin();
	const container = document.createElement("div");
	const renderer = plugin.renderers![0].mount(container);
	const messages = toolMessages();
	const toolCall = messages[0].blocks[0];
	assert.ok(toolCall.type === "tool_call");
	toolCall.name = "grep_search";
	toolCall.argsText = JSON.stringify({ pattern: "TODO", dir_path: "src/", content: "x".repeat(200) });

	renderer.update(toolCall, renderContext(messages, false));

	assert.equal(container.querySelector(".mur-tool-title")?.textContent, "grep_search pattern=TODO dir_path=src/");
});
