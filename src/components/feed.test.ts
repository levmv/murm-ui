import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { AgentRunCollapse, ChatPlugin, Message } from "../core/types";
import { AgentThinkingPlugin } from "../plugins/agent-thinking/agent-thinking-plugin";
import { CopyPlugin } from "../plugins/copy/copy-plugin";
import { ThinkingPlugin } from "../plugins/thinking/thinking-plugin";
import { ToolsPlugin } from "../plugins/tools/tools-plugin";
import { Feed } from "./feed";

interface FeedHarness {
	feed: Feed;
	root: HTMLElement;
	frameCount: () => number;
	flushFrames: () => void;
	scrollCalls: ScrollBehavior[];
	windowScrollCalls: ScrollBehavior[];
	triggerResize: () => void;
	triggerMediaChange: (matches: boolean) => void;
	scrollListenerCounts: () => { scrollArea: number; window: number };
}

function setGlobal(name: string, value: unknown): void {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
		writable: true,
	});
}

function createFeedHarness(
	options: {
		fullscreen?: boolean;
		mobile?: boolean;
		resizeObserver?: boolean;
		plugins?: ChatPlugin[];
		agentRunCollapse?: AgentRunCollapse;
		onReachTop?: () => void;
	} = {},
): FeedHarness {
	const isFullscreen = options.fullscreen !== false;
	const rootClass = `mur-app${isFullscreen ? "" : " mur-app-embedded"}`;
	const dom = new JSDOM(`
		<div class="${rootClass}">
			<div class="mur-chat-scroll-area">
				<div class="mur-chat-history"></div>
			</div>
		</div>
	`);

	const frames = new Map<number, FrameRequestCallback>();
	let nextFrameId = 1;
	const scrollCalls: ScrollBehavior[] = [];
	const windowScrollCalls: ScrollBehavior[] = [];
	let resizeCallback: ResizeObserverCallback | null = null;
	let mediaChangeListener: ((event: MediaQueryListEvent) => void) | null = null;
	let scrollAreaListenerCount = 0;
	let windowScrollListenerCount = 0;

	class MockResizeObserver {
		constructor(callback: ResizeObserverCallback) {
			resizeCallback = callback;
		}

		observe(): void {}
		disconnect(): void {}
	}

	setGlobal("window", dom.window);
	setGlobal("document", dom.window.document);
	setGlobal("DOMParser", dom.window.DOMParser);
	setGlobal("Node", dom.window.Node);
	setGlobal("NodeFilter", dom.window.NodeFilter);
	setGlobal("HTMLElement", dom.window.HTMLElement);
	setGlobal("ResizeObserver", options.resizeObserver ? MockResizeObserver : undefined);
	setGlobal("CSS", { supports: () => false });
	setGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		const id = nextFrameId++;
		frames.set(id, callback);
		return id;
	});
	setGlobal("cancelAnimationFrame", (id: number) => {
		frames.delete(id);
	});

	const scrollArea = dom.window.document.querySelector<HTMLElement>(".mur-chat-scroll-area");
	assert.ok(scrollArea);
	const originalScrollAreaAdd = scrollArea.addEventListener.bind(scrollArea);
	const originalScrollAreaRemove = scrollArea.removeEventListener.bind(scrollArea);
	const originalWindowAdd = dom.window.addEventListener.bind(dom.window);
	const originalWindowRemove = dom.window.removeEventListener.bind(dom.window);

	scrollArea.addEventListener = ((
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: AddEventListenerOptions,
	) => {
		if (type === "scroll") scrollAreaListenerCount++;
		originalScrollAreaAdd(type, listener, options);
	}) as typeof scrollArea.addEventListener;
	scrollArea.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
		if (type === "scroll") scrollAreaListenerCount = Math.max(0, scrollAreaListenerCount - 1);
		originalScrollAreaRemove(type, listener);
	}) as typeof scrollArea.removeEventListener;
	dom.window.addEventListener = ((
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: AddEventListenerOptions,
	) => {
		if (type === "scroll") windowScrollListenerCount++;
		originalWindowAdd(type, listener, options);
	}) as typeof dom.window.addEventListener;
	dom.window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
		if (type === "scroll") windowScrollListenerCount = Math.max(0, windowScrollListenerCount - 1);
		originalWindowRemove(type, listener);
	}) as typeof dom.window.removeEventListener;

	dom.window.HTMLElement.prototype.scrollTo = (options?: ScrollToOptions | number) => {
		if (typeof options === "object" && options?.behavior) {
			scrollCalls.push(options.behavior);
		}
	};
	dom.window.scrollTo = (options?: ScrollToOptions | number) => {
		if (typeof options === "object" && options?.behavior) {
			windowScrollCalls.push(options.behavior);
		}
	};
	dom.window.matchMedia = (query: string) =>
		({
			matches: options.mobile === true && query === "(max-width: 768px)",
			media: query,
			onchange: null,
			addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
				mediaChangeListener = listener;
			},
			removeEventListener: () => {
				mediaChangeListener = null;
			},
			addListener: (listener: (event: MediaQueryListEvent) => void) => {
				mediaChangeListener = listener;
			},
			removeListener: () => {
				mediaChangeListener = null;
			},
			dispatchEvent: () => false,
		}) as MediaQueryList;

	const root = dom.window.document.querySelector<HTMLElement>(".mur-app");
	assert.ok(root);
	const feed = new Feed(root, {
		plugins: options.plugins ?? [],
		fullscreen: isFullscreen,
		agentRunCollapse: options.agentRunCollapse,
		onReachTop: options.onReachTop,
	});

	return {
		feed,
		root,
		frameCount: () => frames.size,
		flushFrames: () => {
			const pending = [...frames.values()];
			frames.clear();
			for (const callback of pending) callback(0);
		},
		scrollCalls,
		windowScrollCalls,
		triggerResize: () => {
			assert.ok(resizeCallback);
			resizeCallback([], {} as ResizeObserver);
		},
		triggerMediaChange: (matches) => {
			assert.ok(mediaChangeListener);
			mediaChangeListener({ matches } as MediaQueryListEvent);
		},
		scrollListenerCounts: () => ({ scrollArea: scrollAreaListenerCount, window: windowScrollListenerCount }),
	};
}

function messages(): Message[] {
	return [
		{
			id: "user-1",
			role: "user",
			blocks: [{ id: "user-1-text", type: "text", text: "Hello" }],
		},
		{
			id: "assistant-1",
			role: "assistant",
			blocks: [],
		},
	];
}

function agentRunMessages(options: { runId?: boolean } = { runId: true }): Message[] {
	const runId = options.runId === false ? undefined : "user-1";
	return [
		{
			id: "user-1",
			role: "user",
			runId,
			createdAt: 1000,
			updatedAt: 1000,
			blocks: [{ id: "user-text", type: "text", text: "List files" }],
		},
		{
			id: "assistant-tool",
			role: "assistant",
			runId,
			createdAt: 1500,
			updatedAt: 2500,
			blocks: [
				{
					id: "tool-call",
					type: "tool_call",
					toolCallId: "call-1",
					name: "list_files",
					argsText: '{"path":"src"}',
					status: "complete",
				},
			],
		},
		{
			id: "tool-result",
			role: "tool",
			runId,
			createdAt: 3000,
			updatedAt: 3000,
			blocks: [
				{
					id: "tool-result-block",
					type: "tool_result",
					toolCallId: "call-1",
					outputText: "src/index.ts",
				},
			],
		},
		{
			id: "assistant-final",
			role: "assistant",
			runId,
			createdAt: 4000,
			updatedAt: 120000,
			blocks: [{ id: "final-text", type: "text", text: "Found src/index.ts." }],
		},
	];
}

function agentRunWithIntermediateProse(): Message[] {
	return [
		{
			id: "user-1",
			role: "user",
			runId: "run-1",
			createdAt: 1000,
			updatedAt: 1000,
			blocks: [{ id: "user-text", type: "text", text: "Clean it up" }],
		},
		{
			id: "assistant-mixed",
			role: "assistant",
			runId: "run-1",
			createdAt: 1500,
			updatedAt: 2500,
			blocks: [
				{ id: "assistant-mixed-reasoning", type: "reasoning", text: "Need to remove a stale file." },
				{ id: "assistant-mixed-text", type: "text", text: "I found a stale file and will remove it." },
				{
					id: "assistant-mixed-tool",
					type: "tool_call",
					toolCallId: "call-1",
					name: "delete_file",
					argsText: '{"path":"playground/tmp.md"}',
					status: "complete",
				},
			],
		},
		{
			id: "tool-result",
			role: "tool",
			runId: "run-1",
			createdAt: 3000,
			updatedAt: 3000,
			blocks: [{ id: "tool-result-block", type: "tool_result", toolCallId: "call-1", outputText: "deleted" }],
		},
		{
			id: "assistant-final",
			role: "assistant",
			runId: "run-1",
			createdAt: 4000,
			updatedAt: 120000,
			blocks: [{ id: "final-text", type: "text", text: "The stale file is gone." }],
		},
	];
}

function agentRunWithTwoWorkSegments(): Message[] {
	return [
		{
			id: "user-1",
			role: "user",
			runId: "run-2",
			createdAt: 0,
			updatedAt: 0,
			blocks: [{ id: "user-text", type: "text", text: "Do two things" }],
		},
		{
			id: "assistant-first",
			role: "assistant",
			runId: "run-2",
			createdAt: 1000,
			updatedAt: 1000,
			blocks: [
				{ id: "assistant-first-text", type: "text", text: "First, I will inspect it." },
				{
					id: "assistant-first-tool",
					type: "tool_call",
					toolCallId: "call-first",
					name: "first_tool",
					argsText: "{}",
					status: "complete",
				},
			],
		},
		{
			id: "tool-result-first",
			role: "tool",
			runId: "run-2",
			createdAt: 1100,
			updatedAt: 1100,
			blocks: [{ id: "tool-result-first-block", type: "tool_result", toolCallId: "call-first", outputText: "ok" }],
		},
		{
			id: "assistant-second",
			role: "assistant",
			runId: "run-2",
			createdAt: 1400,
			updatedAt: 1400,
			blocks: [
				{ id: "assistant-second-text", type: "text", text: "Second, I will patch it." },
				{
					id: "assistant-second-tool",
					type: "tool_call",
					toolCallId: "call-second",
					name: "second_tool",
					argsText: "{}",
					status: "complete",
				},
			],
		},
		{
			id: "tool-result-second",
			role: "tool",
			runId: "run-2",
			createdAt: 1450,
			updatedAt: 1450,
			blocks: [{ id: "tool-result-second-block", type: "tool_result", toolCallId: "call-second", outputText: "ok" }],
		},
		{
			id: "assistant-final",
			role: "assistant",
			runId: "run-2",
			createdAt: 2500,
			updatedAt: 2500,
			blocks: [{ id: "final-text", type: "text", text: "Both steps are done." }],
		},
	];
}

function agentRunWithSameTimestampWork(): Message[] {
	return [
		{
			id: "user-1",
			role: "user",
			runId: "run-4",
			createdAt: 1000,
			updatedAt: 1000,
			blocks: [{ id: "user-text", type: "text", text: "Run a timestamp-collapsed tool" }],
		},
		{
			id: "assistant-tool",
			role: "assistant",
			runId: "run-4",
			createdAt: 1000,
			updatedAt: 1000,
			blocks: [
				{
					id: "assistant-tool-call",
					type: "tool_call",
					toolCallId: "call-fast",
					name: "fast_tool",
					argsText: "{}",
					status: "complete",
				},
			],
		},
		{
			id: "tool-result",
			role: "tool",
			runId: "run-4",
			createdAt: 1000,
			updatedAt: 1000,
			blocks: [{ id: "tool-result-block", type: "tool_result", toolCallId: "call-fast", outputText: "ok" }],
		},
		{
			id: "assistant-final",
			role: "assistant",
			runId: "run-4",
			createdAt: 1000,
			updatedAt: 1000,
			blocks: [{ id: "final-text", type: "text", text: "Done." }],
		},
	];
}

function setScrollMetrics(
	scrollArea: HTMLElement,
	metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
): void {
	Object.defineProperties(scrollArea, {
		scrollTop: { configurable: true, value: metrics.scrollTop, writable: true },
		scrollHeight: { configurable: true, value: metrics.scrollHeight },
		clientHeight: { configurable: true, value: metrics.clientHeight },
	});
}

function setComputedScrollMetrics(
	scrollArea: HTMLElement,
	metrics: { scrollTop: number; scrollHeight: () => number; clientHeight: number },
): { getScrollTop: () => number; setScrollTop: (scrollTop: number) => void } {
	let scrollTop = metrics.scrollTop;
	Object.defineProperties(scrollArea, {
		scrollTop: {
			configurable: true,
			get: () => scrollTop,
			set: (value: number) => {
				scrollTop = value;
			},
		},
		scrollHeight: { configurable: true, get: metrics.scrollHeight },
		clientHeight: { configurable: true, value: metrics.clientHeight },
	});
	return {
		getScrollTop: () => scrollTop,
		setScrollTop: (value) => {
			scrollTop = value;
		},
	};
}

function setWindowScrollMetrics(metrics: { scrollTop: number; scrollHeight: number; clientHeight: number }): void {
	Object.defineProperty(window, "scrollY", {
		configurable: true,
		value: metrics.scrollTop,
	});
	Object.defineProperty(window, "innerHeight", {
		configurable: true,
		value: metrics.clientHeight,
	});
	Object.defineProperties(document.documentElement, {
		scrollTop: { configurable: true, value: metrics.scrollTop, writable: true },
		scrollHeight: { configurable: true, value: metrics.scrollHeight },
	});
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

test("desktop generation coalesces streaming updates into one smooth scroll", () => {
	const { feed, frameCount, flushFrames, scrollCalls, scrollListenerCounts } = createFeedHarness();
	const currentMessages = messages();
	assert.deepEqual(scrollListenerCounts(), { scrollArea: 1, window: 0 });

	feed.scrollToLatest();
	feed.update(currentMessages, { streamingMessageIds: new Set(["assistant-1"]) });
	feed.update(currentMessages, { streamingMessageIds: new Set(["assistant-1"]) });

	assert.equal(frameCount(), 1);
	flushFrames();
	assert.deepEqual(scrollCalls, ["smooth"]);

	feed.destroy();
	assert.deepEqual(scrollListenerCounts(), { scrollArea: 0, window: 0 });
});

test("changing the mobile layout transfers the scroll listener and resets its position baseline", () => {
	const { feed, root, frameCount, flushFrames, triggerMediaChange, scrollListenerCounts } = createFeedHarness();
	const scrollArea = root.querySelector<HTMLElement>(".mur-chat-scroll-area");
	assert.ok(scrollArea);
	const currentMessages = messages();
	assert.deepEqual(scrollListenerCounts(), { scrollArea: 1, window: 0 });

	feed.update(currentMessages);
	flushFrames();

	setScrollMetrics(scrollArea, { scrollTop: 400, scrollHeight: 500, clientHeight: 100 });
	scrollArea.dispatchEvent(new window.Event("scroll"));

	setWindowScrollMetrics({ scrollTop: 100, scrollHeight: 1000, clientHeight: 500 });
	triggerMediaChange(true);
	assert.deepEqual(scrollListenerCounts(), { scrollArea: 0, window: 1 });
	window.dispatchEvent(new window.Event("scroll"));

	feed.update(currentMessages);

	assert.equal(frameCount(), 1);
	triggerMediaChange(false);
	assert.deepEqual(scrollListenerCounts(), { scrollArea: 1, window: 0 });

	feed.destroy();
	assert.deepEqual(scrollListenerCounts(), { scrollArea: 0, window: 0 });
});

test("mobile generation scrolls the window", () => {
	const { feed, frameCount, flushFrames, scrollCalls, windowScrollCalls, scrollListenerCounts } = createFeedHarness({
		mobile: true,
	});
	assert.deepEqual(scrollListenerCounts(), { scrollArea: 0, window: 1 });

	feed.scrollToLatest();
	feed.update(messages(), { streamingMessageIds: new Set(["assistant-1"]) });

	assert.equal(frameCount(), 1);
	flushFrames();
	assert.deepEqual(scrollCalls, []);
	assert.deepEqual(windowScrollCalls, ["smooth"]);

	feed.destroy();
	assert.deepEqual(scrollListenerCounts(), { scrollArea: 0, window: 0 });
});

test("mobile embedded generation scrolls the scroll area", () => {
	const { feed, frameCount, flushFrames, scrollCalls, windowScrollCalls, scrollListenerCounts } = createFeedHarness({
		fullscreen: false,
		mobile: true,
	});
	assert.deepEqual(scrollListenerCounts(), { scrollArea: 1, window: 0 });

	feed.scrollToLatest();
	feed.update(messages(), { streamingMessageIds: new Set(["assistant-1"]) });

	assert.equal(frameCount(), 1);
	flushFrames();
	assert.deepEqual(scrollCalls, ["smooth"]);
	assert.deepEqual(windowScrollCalls, []);

	feed.destroy();
	assert.deepEqual(scrollListenerCounts(), { scrollArea: 0, window: 0 });
});

test("resize observer flushes a pending smooth scroll once, retaining its behavior", () => {
	const { feed, frameCount, flushFrames, scrollCalls, triggerResize } = createFeedHarness({ resizeObserver: true });

	feed.scrollToLatest();
	feed.update(messages(), { streamingMessageIds: new Set(["assistant-1"]) });
	triggerResize();

	assert.equal(frameCount(), 0);
	assert.deepEqual(scrollCalls, ["smooth"]);
	flushFrames();
	assert.deepEqual(scrollCalls, ["smooth"]);

	feed.destroy();
});

test("resizing follows the bottom before paint, with or without a pending frame", () => {
	const { feed, root, frameCount, flushFrames, triggerResize } = createFeedHarness({ resizeObserver: true });
	const area = root.querySelector<HTMLElement>(".mur-chat-scroll-area")!;
	setScrollMetrics(area, { scrollTop: 100, scrollHeight: 600, clientHeight: 500 });
	area.dispatchEvent(new window.Event("scroll"));
	feed.update(messages(), { streamingMessageIds: new Set(["assistant-1"]) });
	assert.equal(frameCount(), 1);
	let writes = 0;
	area.scrollTo = (options?: ScrollToOptions | number) => {
		assert.equal(typeof options, "object");
		writes++;
		area.scrollTop = (options as ScrollToOptions).top! - area.clientHeight;
	};
	// Async Markdown has added a line after the render update.
	setScrollMetrics(area, { scrollTop: 100, scrollHeight: 626, clientHeight: 500 });
	triggerResize();
	assert.equal(area.scrollTop, 126);
	assert.equal(frameCount(), 0);
	flushFrames();
	assert.equal(writes, 1);

	setScrollMetrics(area, { scrollTop: 126, scrollHeight: 650, clientHeight: 500 });
	triggerResize();
	assert.equal(area.scrollTop, 150);
	assert.equal(frameCount(), 0);
	flushFrames();
	assert.equal(writes, 2);
	feed.destroy();
});

test("late content resizing neither reads layout nor pulls a history reader to the bottom", () => {
	const { feed, root, frameCount, scrollCalls, triggerResize } = createFeedHarness({ resizeObserver: true });
	const area = root.querySelector<HTMLElement>(".mur-chat-scroll-area")!;
	setScrollMetrics(area, { scrollTop: 500, scrollHeight: 1000, clientHeight: 500 });
	area.dispatchEvent(new window.Event("scroll"));
	setScrollMetrics(area, { scrollTop: 200, scrollHeight: 1000, clientHeight: 500 });
	area.dispatchEvent(new window.Event("scroll"));
	Object.defineProperty(area, "scrollHeight", {
		get() {
			throw new Error("Unnecessary layout read");
		},
	});
	triggerResize();
	assert.equal(area.scrollTop, 200);
	assert.deepEqual(scrollCalls, []);
	assert.equal(frameCount(), 0);
	feed.destroy();
	triggerResize();
	assert.deepEqual(scrollCalls, []);
});

test("fullscreen mobile resize follows the window in the same rendering cycle", () => {
	const { feed, frameCount, scrollCalls, windowScrollCalls, triggerResize } = createFeedHarness({
		mobile: true,
		resizeObserver: true,
	});
	triggerResize();
	assert.equal(frameCount(), 0);
	assert.deepEqual(scrollCalls, []);
	assert.deepEqual(windowScrollCalls, ["auto"]);
	feed.destroy();
});

test("loading a session resets sticky bottom intent", () => {
	const { feed, root, frameCount, flushFrames, scrollCalls } = createFeedHarness();
	const scrollArea = root.querySelector<HTMLElement>(".mur-chat-scroll-area");
	assert.ok(scrollArea);

	feed.update(messages());
	flushFrames();
	scrollCalls.length = 0;

	setScrollMetrics(scrollArea, { scrollTop: 400, scrollHeight: 500, clientHeight: 100 });
	scrollArea.dispatchEvent(new window.Event("scroll"));
	setScrollMetrics(scrollArea, { scrollTop: 100, scrollHeight: 500, clientHeight: 100 });
	scrollArea.dispatchEvent(new window.Event("scroll"));

	feed.update(messages());
	assert.equal(frameCount(), 0);

	feed.update([], { loading: true });
	feed.update([
		{
			id: "new-user-1",
			role: "user",
			blocks: [{ id: "new-user-1-text", type: "text", text: "New chat" }],
		},
	]);

	assert.equal(frameCount(), 1);
	flushFrames();
	assert.deepEqual(scrollCalls, ["smooth"]);

	feed.destroy();
});

test("prepended older messages preserve scroll when feed items regroup", () => {
	let reachTopCalls = 0;
	const { feed, root, flushFrames } = createFeedHarness({
		onReachTop: () => {
			reachTopCalls++;
		},
	});
	const scrollArea = root.querySelector<HTMLElement>(".mur-chat-scroll-area");
	assert.ok(scrollArea);
	const metrics = setComputedScrollMetrics(scrollArea, {
		scrollTop: 0,
		scrollHeight: () => 900 + root.querySelectorAll(".mur-message").length * 100,
		clientHeight: 500,
	});
	const currentHead: Message = {
		id: "assistant-final",
		role: "assistant",
		runId: "run-1",
		blocks: [{ id: "final-text", type: "text", text: "Current visible answer." }],
	};

	feed.update([currentHead]);
	flushFrames();
	feed.setOlderMessagesState(true, false);

	metrics.setScrollTop(400);
	scrollArea.dispatchEvent(new window.Event("scroll"));
	metrics.setScrollTop(120);
	scrollArea.dispatchEvent(new window.Event("scroll"));
	assert.equal(reachTopCalls, 1);

	const beforeTop = metrics.getScrollTop();
	const beforeHeight = scrollArea.scrollHeight;
	feed.update([
		{
			id: "user-1",
			role: "user",
			runId: "run-1",
			blocks: [{ id: "user-text", type: "text", text: "Please inspect it" }],
		},
		{
			id: "assistant-tool",
			role: "assistant",
			runId: "run-1",
			blocks: [
				{
					id: "tool-call",
					type: "tool_call",
					toolCallId: "call-1",
					name: "inspect",
					argsText: "{}",
					status: "complete",
				},
			],
		},
		{
			id: "tool-result",
			role: "tool",
			runId: "run-1",
			blocks: [{ id: "tool-result-block", type: "tool_result", toolCallId: "call-1", outputText: "ok" }],
		},
		currentHead,
	]);

	assert.equal(metrics.getScrollTop(), beforeTop + scrollArea.scrollHeight - beforeHeight);
	scrollArea.dispatchEvent(new window.Event("scroll"));
	assert.equal(reachTopCalls, 1);

	feed.destroy();
});

test("older message loading shows a visible status", () => {
	const { feed, root } = createFeedHarness();

	feed.setOlderMessagesState(true, true);

	const status = root.querySelector<HTMLElement>(".mur-feed-older-status");
	assert.ok(status);
	assert.equal(status.getAttribute("role"), "status");
	assert.match(status.textContent ?? "", /Loading older messages/);
	assert.equal(status.closest<HTMLElement>(".mur-feed-spinner-top")?.hidden, false);

	feed.destroy();
});

test("prepend compensation does not double the browser's native scroll anchoring", () => {
	const { feed, root, flushFrames } = createFeedHarness({ fullscreen: false });
	const area = root.querySelector<HTMLElement>(".mur-chat-scroll-area")!;
	let emulateNativeAnchor = false;
	let previousHeight = 0;
	const metrics = setComputedScrollMetrics(area, {
		scrollTop: 0,
		clientHeight: 500,
		scrollHeight: () => {
			const height = 900 + root.querySelectorAll(".mur-message").length * 100;
			if (emulateNativeAnchor) metrics.setScrollTop(metrics.getScrollTop() + height - previousHeight);
			previousHeight = height;
			return height;
		},
	});
	const current = messages();
	feed.update(current);
	flushFrames();
	metrics.setScrollTop(400);
	area.dispatchEvent(new window.Event("scroll"));
	metrics.setScrollTop(300);
	area.dispatchEvent(new window.Event("scroll"));
	emulateNativeAnchor = true;
	feed.update([{ id: "older", role: "user", blocks: [] }, ...current]);
	assert.equal(metrics.getScrollTop(), 400);
	feed.destroy();
});

test("pagination spinner compensates once even when the browser anchors it", () => {
	const { feed, root } = createFeedHarness({ fullscreen: false });
	const area = root.querySelector<HTMLElement>(".mur-chat-scroll-area")!;
	const metrics = setComputedScrollMetrics(area, { scrollTop: 0, clientHeight: 500, scrollHeight: () => 1500 });
	metrics.setScrollTop(400);
	area.dispatchEvent(new window.Event("scroll"));
	metrics.setScrollTop(300);
	area.dispatchEvent(new window.Event("scroll"));
	const spinner = root.querySelector<HTMLElement>(".mur-feed-spinner-top")!;
	let previousHeight = 0;
	Object.defineProperty(spinner, "offsetHeight", {
		get() {
			const height = spinner.hidden ? 0 : 42;
			metrics.setScrollTop(metrics.getScrollTop() + height - previousHeight);
			previousHeight = height;
			return height;
		},
	});
	feed.setOlderMessagesState(true, true);
	assert.equal(metrics.getScrollTop(), 342);
	feed.setOlderMessagesState(true, false);
	assert.equal(metrics.getScrollTop(), 300);
	feed.destroy();
});

test("composer shrinkage at the bottom does not request history; scrolling up still does", () => {
	let pages = 0;
	const { feed, root } = createFeedHarness({
		fullscreen: false,
		onReachTop: () => {
			pages++;
		},
	});
	const area = root.querySelector<HTMLElement>(".mur-chat-scroll-area")!;
	feed.setOlderMessagesState(true, false);
	setScrollMetrics(area, { scrollTop: 180, scrollHeight: 780, clientHeight: 600 });
	area.dispatchEvent(new window.Event("scroll"));
	// Browser clamps scrollTop as removal of attachments increases the viewport.
	setScrollMetrics(area, { scrollTop: 80, scrollHeight: 780, clientHeight: 700 });
	area.dispatchEvent(new window.Event("scroll"));
	assert.equal(pages, 0);
	setScrollMetrics(area, { scrollTop: 40, scrollHeight: 780, clientHeight: 700 });
	area.dispatchEvent(new window.Event("scroll"));
	assert.equal(pages, 1);
	feed.destroy();
});

test("code block copy button writes the rendered code text", async () => {
	const { feed, root } = createFeedHarness();
	const copied: string[] = [];

	setGlobal("navigator", {
		clipboard: {
			writeText: async (text: string) => {
				copied.push(text);
			},
		},
	});

	feed.update([
		{
			id: "assistant-1",
			role: "assistant",
			blocks: [{ id: "text-1", type: "text", text: "```ts\nconst x = 1;\n```" }],
		},
	]);
	await flushMicrotasks();

	const copyBtn = root.querySelector<HTMLButtonElement>(".mur-code-copy-btn");
	assert.ok(copyBtn);
	assert.equal(root.querySelector(".mur-code-language")?.textContent, "ts");

	copyBtn.click();
	await flushMicrotasks();

	assert.equal(copied.length, 1);
	assert.match(copied[0], /const x = 1;/);

	feed.destroy();
});

test("agent runs collapse intermediate messages after generation finishes", async () => {
	const { feed, root } = createFeedHarness({ plugins: [ToolsPlugin()] });
	feed.update(agentRunMessages().slice(0, 3), { streamingMessageIds: new Set(["assistant-tool"]) });
	assert.equal(root.querySelector(".mur-agent-run-summary")?.getAttribute("aria-expanded"), "true");
	assert.ok(root.querySelector(".mur-agent-run-steps .mur-tool-summary"));

	feed.update(agentRunMessages());
	await flushMicrotasks();

	const summary = root.querySelector<HTMLButtonElement>(".mur-agent-run-summary");
	assert.ok(summary);
	assert.equal(summary.textContent, "1 tool call, 1m 59s");
	assert.equal(summary.getAttribute("aria-expanded"), "false");
	assert.equal(root.querySelector(".mur-agent-run-steps")?.childElementCount, 0);
	assert.equal(root.querySelectorAll(".mur-message").length, 2);
	assert.match(root.querySelector(".mur-message-assistant")?.textContent ?? "", /Found src\/index\.ts/);

	summary.click();
	await flushMicrotasks();

	assert.equal(summary.textContent, "1 tool call, 1m 59s");
	assert.equal(summary.getAttribute("aria-expanded"), "true");
	assert.equal(root.querySelectorAll(".mur-agent-run-steps .mur-message").length, 1);
	assert.equal(root.querySelector(".mur-agent-run-steps .mur-message-tool"), null);
	assert.equal(root.querySelectorAll(".mur-message").length, 3);
	root.querySelector<HTMLButtonElement>(".mur-agent-run-steps .mur-tool-summary")!.click();
	assert.match(root.querySelector(".mur-tool-details")?.textContent ?? "", /src\/index\.ts/);

	feed.destroy();
});

test("agent run work summary includes the tool call count", async () => {
	const { feed, root } = createFeedHarness();
	const transcript = agentRunMessages();
	const toolMessage = transcript[1];
	toolMessage.blocks = [
		...toolMessage.blocks,
		{
			id: "tool-call-2",
			type: "tool_call",
			toolCallId: "call-2",
			name: "read_file",
			argsText: '{"path":"src/index.ts"}',
			status: "complete",
		},
	];

	feed.update(transcript);
	await flushMicrotasks();

	assert.equal(root.querySelector(".mur-agent-run-summary")?.textContent, "2 tool calls, 1m 59s");

	feed.destroy();
});

test("machinery agent runs keep assistant prose visible and fold tool calls", async () => {
	const { feed, root } = createFeedHarness();

	feed.update(agentRunWithIntermediateProse());
	await flushMicrotasks();

	const summary = root.querySelector<HTMLButtonElement>(".mur-agent-run-summary");
	assert.ok(summary);
	assert.equal(summary.getAttribute("aria-expanded"), "false");
	assert.match(root.textContent ?? "", /I found a stale file/);
	assert.match(root.textContent ?? "", /The stale file is gone/);
	assert.doesNotMatch(root.textContent ?? "", /Tool Call: delete_file/);
	assert.equal(root.querySelectorAll(".mur-message").length, 3);
	assert.deepEqual(
		Array.from(root.querySelector(".mur-agent-run")?.children ?? []).map((child) =>
			(child.textContent ?? "").replace(/\s+/g, " ").trim(),
		),
		["Clean it up", "I found a stale file and will remove it.", "1 tool call, 1m 58s", "The stale file is gone."],
	);

	summary.click();
	await flushMicrotasks();

	assert.equal(summary.getAttribute("aria-expanded"), "true");
	assert.match(root.querySelector(".mur-agent-run-steps")?.textContent ?? "", /Tool Call: delete_file/);

	summary.click();
	await flushMicrotasks();

	assert.equal(summary.getAttribute("aria-expanded"), "false");
	assert.doesNotMatch(root.textContent ?? "", /Tool Call: delete_file/);

	feed.destroy();
});

test("agent run work toggles expand only their own segment", async () => {
	const { feed, root } = createFeedHarness();

	feed.update(agentRunWithTwoWorkSegments());
	await flushMicrotasks();

	const summaries = Array.from(root.querySelectorAll<HTMLButtonElement>(".mur-agent-run-summary"));
	assert.equal(summaries.length, 2);
	assert.deepEqual(
		summaries.map((summary) => summary.textContent),
		["1 tool call, 400ms", "1 tool call, 1s"],
	);

	summaries[1].click();
	await flushMicrotasks();

	const workSegments = Array.from(root.querySelectorAll<HTMLElement>(".mur-agent-run-work"));
	assert.equal(summaries[0].getAttribute("aria-expanded"), "false");
	assert.equal(summaries[1].getAttribute("aria-expanded"), "true");
	assert.equal(workSegments[0].querySelector(".mur-agent-run-steps")?.childElementCount, 0);
	assert.equal(workSegments[1].querySelector(".mur-agent-run-steps")?.childElementCount, 1);
	assert.doesNotMatch(workSegments[1].textContent ?? "", /first_tool/);
	assert.match(workSegments[1].textContent ?? "", /second_tool/);

	feed.destroy();
});

test("agent run work duration omits zero values from coarse timestamps", async () => {
	const { feed, root } = createFeedHarness();

	feed.update(agentRunWithSameTimestampWork());
	await flushMicrotasks();

	assert.equal(root.querySelector(".mur-agent-run-summary")?.textContent, "1 tool call");

	feed.destroy();
});

test("agent run final reasoning stays inside the folded work segment", async () => {
	const { feed, root } = createFeedHarness({ plugins: [ThinkingPlugin()] });
	const transcript = agentRunMessages();
	const finalMessage = transcript[transcript.length - 1];
	finalMessage.blocks = [
		{ id: "final-reasoning", type: "reasoning", text: "Private final reasoning." },
		...finalMessage.blocks,
	];

	feed.update(transcript);
	await flushMicrotasks();

	const summary = root.querySelector<HTMLButtonElement>(".mur-agent-run-summary");
	assert.ok(summary);
	assert.doesNotMatch(root.textContent ?? "", /Thought Process/);
	assert.doesNotMatch(root.textContent ?? "", /Private final reasoning/);
	assert.match(root.textContent ?? "", /Found src\/index\.ts/);

	summary.click();
	await flushMicrotasks();

	const thinkingToggle = root.querySelector<HTMLButtonElement>(".mur-agent-run-steps .mur-think-toggle");
	assert.ok(thinkingToggle);
	assert.match(root.querySelector(".mur-agent-run-steps")?.textContent ?? "", /Thought Process/);

	thinkingToggle.click();
	await flushMicrotasks();
	assert.match(root.querySelector(".mur-agent-run-steps")?.textContent ?? "", /Private final reasoning/);

	feed.destroy();
});

test("reasoning-only agent work uses a thought summary", async () => {
	const { feed, root } = createFeedHarness();
	const transcript: Message[] = [
		{
			id: "user-1",
			role: "user",
			runId: "run-thought",
			createdAt: 1000,
			updatedAt: 1000,
			blocks: [{ id: "user-text", type: "text", text: "Explain" }],
		},
		{
			id: "assistant-final",
			role: "assistant",
			runId: "run-thought",
			createdAt: 11000,
			updatedAt: 11000,
			blocks: [
				{ id: "final-reasoning", type: "reasoning", text: "Private reasoning." },
				{ id: "final-text", type: "text", text: "The answer is visible." },
			],
		},
	];

	feed.update(transcript);
	await flushMicrotasks();

	assert.equal(root.querySelector(".mur-agent-run-summary")?.textContent, "Thought for 10s");
	assert.match(root.textContent ?? "", /The answer is visible/);
	assert.doesNotMatch(root.textContent ?? "", /Private reasoning/);

	feed.destroy();
});

test("agent thinking plugin renders folded reasoning as inline preview text", async () => {
	const { feed, root } = createFeedHarness({ plugins: [AgentThinkingPlugin()] });
	const transcript = agentRunMessages();
	const finalMessage = transcript[transcript.length - 1];
	finalMessage.blocks = [
		{
			id: "final-reasoning",
			type: "reasoning",
			text: "Private final reasoning.\nMore private reasoning.\nThird private line.\nFourth private line.",
		},
		...finalMessage.blocks,
	];

	feed.update(transcript);
	await flushMicrotasks();

	const summary = root.querySelector<HTMLButtonElement>(".mur-agent-run-summary");
	assert.ok(summary);
	assert.doesNotMatch(root.textContent ?? "", /Private final reasoning/);
	assert.doesNotMatch(root.textContent ?? "", /Thought Process/);

	summary.click();
	await flushMicrotasks();

	const preview = root.querySelector<HTMLElement>(".mur-agent-run-steps .mur-agent-think-preview");
	assert.ok(preview);
	assert.equal(preview.dataset.expandable, "true");
	assert.equal(preview.getAttribute("aria-expanded"), "false");
	assert.match(root.querySelector(".mur-agent-run-steps")?.textContent ?? "", /Private final reasoning/);
	assert.doesNotMatch(root.querySelector(".mur-agent-run-steps")?.textContent ?? "", /Thought Process/);

	preview.click();
	assert.equal(preview.getAttribute("aria-expanded"), "true");

	feed.destroy();
});

test("agent run grouping falls back to user boundaries for old transcripts without run ids", async () => {
	const { feed, root } = createFeedHarness();

	feed.update(agentRunMessages({ runId: false }));
	await flushMicrotasks();

	assert.equal(root.querySelector(".mur-agent-run-summary")?.textContent, "1 tool call, 1m 59s");
	assert.equal(root.querySelectorAll(".mur-message").length, 2);

	feed.destroy();
});

test("text-only multi-assistant replies stay flat", async () => {
	const { feed, root } = createFeedHarness();
	const transcript: Message[] = [
		{
			id: "user-1",
			role: "user",
			runId: "user-1",
			blocks: [{ id: "user-text", type: "text", text: "Explain" }],
		},
		{
			id: "assistant-1",
			role: "assistant",
			runId: "user-1",
			blocks: [{ id: "text-1", type: "text", text: "Part one." }],
		},
		{
			id: "assistant-2",
			role: "assistant",
			runId: "user-1",
			blocks: [{ id: "text-2", type: "text", text: "Part two." }],
		},
	];

	feed.update(transcript);
	await flushMicrotasks();

	assert.equal(root.querySelector(".mur-agent-run-summary"), null);
	assert.equal(root.querySelectorAll(".mur-message").length, 3);
	assert.match(root.textContent ?? "", /Part one/);
	assert.match(root.textContent ?? "", /Part two/);

	feed.destroy();
});

test("message-scoped errors render only on the matching message", () => {
	const { feed, root } = createFeedHarness();

	const transcript = messages();
	transcript[1].error = "Provider failed";
	feed.update(transcript, { streamingMessageIds: new Set(["assistant-1"]) });

	const errors = root.querySelectorAll(".mur-message-error");
	assert.equal(errors.length, 1);
	assert.match(errors[0].textContent ?? "", /Provider failed/);
	assert.equal(errors[0].closest(".mur-message")?.classList.contains("mur-message-assistant"), true);

	feed.destroy();
});

test("a throwing plugin does not break block rendering or other plugins' actions", async () => {
	const brokenPlugin: ChatPlugin = {
		name: "broken",

		getActionButtons: () => {
			throw new Error("actions boom");
		},
	};
	const { feed, root } = createFeedHarness({ plugins: [brokenPlugin, CopyPlugin()] });

	setGlobal("navigator", {
		clipboard: {
			writeText: async () => {},
		},
	});

	feed.update([
		{
			id: "assistant-1",
			role: "assistant",
			blocks: [{ id: "text-1", type: "text", text: "Still **rendered**" }],
		},
	]);
	await flushMicrotasks();

	assert.match(root.querySelector(".mur-block-text")?.textContent ?? "", /Still rendered/);
	assert.ok(root.querySelector(".mur-action-icon-btn"));

	feed.destroy();
});
