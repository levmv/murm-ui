import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { BlockRenderContext, ContentBlock, Message } from "../../core/types";
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

function renderContext(messages: Message[]): BlockRenderContext {
	return {
		message: messages[0],
		messages,
		blockIndex: 0,
	};
}

test("ToolsPlugin renders a compact tool call and expands matching result", () => {
	installDom();
	const plugin = ToolsPlugin();
	const container = document.createElement("div");
	const messages = toolMessages();
	const toolCall = messages[0].blocks[0] as Extract<ContentBlock, { type: "tool_call" }>;

	assert.equal(plugin.onBlockRender?.(toolCall, container, false, renderContext(messages)), true);

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
	const messages = toolMessages();
	const toolCall = messages[0].blocks[0] as Extract<ContentBlock, { type: "tool_call" }>;

	assert.equal(plugin.onBlockRender?.(toolCall, container, false, renderContext(messages)), true);

	assert.equal(container.querySelector(".mur-tool-title")?.textContent, "ls agent-experiment");
	assert.equal(container.querySelector<HTMLElement>(".mur-tool-details")?.hidden, false);
	assert.match(container.textContent ?? "", /app\.ts \| file/);
});

test("ToolsPlugin updates an existing tool block when the result arrives", () => {
	installDom();
	const plugin = ToolsPlugin();
	const container = document.createElement("div");
	const messages = toolMessages("running");
	const toolCall = messages[0].blocks[0] as Extract<ContentBlock, { type: "tool_call" }>;
	messages.splice(1);

	assert.equal(plugin.onBlockRender?.(toolCall, container, true, renderContext(messages)), true);
	assert.equal(container.querySelector(".mur-tool-status")?.textContent, "...");

	messages[0].blocks[0] = {
		...toolCall,
		status: "complete",
	};
	messages.push(toolMessages()[1]);

	assert.equal(plugin.onBlockRender?.(messages[0].blocks[0], container, false, renderContext(messages)), true);
	assert.equal(container.querySelector(".mur-tool-status")?.textContent, "✓");
	container.querySelector<HTMLButtonElement>(".mur-tool-summary")?.click();
	assert.equal(container.querySelectorAll<HTMLElement>(".mur-tool-section")[1]?.hidden, false);
	assert.match(container.textContent ?? "", /package\.json/);
});

test("ToolsPlugin invalidates a cached result when the transcript changes", () => {
	installDom();
	const plugin = ToolsPlugin({ defaultExpanded: true });
	const container = document.createElement("div");
	const messages = toolMessages();
	const toolCall = messages[0].blocks[0] as Extract<ContentBlock, { type: "tool_call" }>;

	assert.equal(plugin.onBlockRender?.(toolCall, container, false, renderContext(messages)), true);
	assert.match(container.textContent ?? "", /agent-experiment\/app\.ts/);

	const messagesWithoutResult = [messages[0]];
	assert.equal(plugin.onBlockRender?.(toolCall, container, false, renderContext(messagesWithoutResult)), true);

	assert.doesNotMatch(container.textContent ?? "", /agent-experiment\/app\.ts/);
	assert.match(container.textContent ?? "", /No result\./);
});

test("ToolsPlugin summarizes multiple important args without letting long values dominate", () => {
	installDom();
	const plugin = ToolsPlugin();
	const container = document.createElement("div");
	const messages = [
		{
			id: "assistant-1",
			role: "assistant" as const,
			blocks: [
				{
					id: "tool-block-1",
					type: "tool_call" as const,
					toolCallId: "call-1",
					name: "grep_search",
					argsText: JSON.stringify({
						pattern: "TODO",
						dir_path: "src/",
						content: "x".repeat(200),
					}),
					status: "complete" as const,
				},
			],
		},
	];
	const toolCall = messages[0].blocks[0];

	assert.equal(plugin.onBlockRender?.(toolCall, container, false, renderContext(messages)), true);

	assert.equal(container.querySelector(".mur-tool-title")?.textContent, "grep_search pattern=TODO dir_path=src/");
});

test("ToolsPlugin keeps single preferred args terse", () => {
	installDom();
	const plugin = ToolsPlugin();
	const container = document.createElement("div");
	const messages = [
		{
			id: "assistant-1",
			role: "assistant" as const,
			blocks: [
				{
					id: "tool-block-1",
					type: "tool_call" as const,
					toolCallId: "call-1",
					name: "search_text",
					argsText: JSON.stringify({ query: "ChatProvider" }),
					status: "complete" as const,
				},
			],
		},
	];
	const toolCall = messages[0].blocks[0];

	assert.equal(plugin.onBlockRender?.(toolCall, container, false, renderContext(messages)), true);

	assert.equal(container.querySelector(".mur-tool-title")?.textContent, "search_text ChatProvider");
});
