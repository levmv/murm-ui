import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { ChatPlugin, Message, MessageActionContext } from "../core/types";
import { CopyPlugin } from "../plugins/copy/copy-plugin";
import { EditPlugin } from "../plugins/edit/edit-plugin";
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
	options: { mobile?: boolean; resizeObserver?: boolean; plugins?: ChatPlugin[] } = {},
): FeedHarness {
	const dom = new JSDOM(`
		<div class="mur-chat-scroll-area">
			<div class="mur-chat-history"></div>
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

	const feed = new Feed(dom.window.document.body, { plugins: options.plugins ?? [] });

	return {
		feed,
		root: dom.window.document.body,
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

test("generation start schedules one smooth scroll", () => {
	const { feed, frameCount, flushFrames, scrollCalls } = createFeedHarness();

	feed.update(messages(), "assistant-1", false, true);

	assert.equal(frameCount(), 1);
	flushFrames();
	assert.deepEqual(scrollCalls, ["smooth"]);

	feed.destroy();
});

test("chat history is marked busy while a response is generating", () => {
	const { feed, root } = createFeedHarness();
	const history = root.querySelector<HTMLElement>(".mur-chat-history");
	assert.ok(history);
	const originalSetAttribute = history.setAttribute.bind(history);
	let busyAttributeWrites = 0;
	history.setAttribute = ((name: string, value: string) => {
		if (name === "aria-busy") busyAttributeWrites++;
		originalSetAttribute(name, value);
	}) as typeof history.setAttribute;

	feed.update(messages(), "assistant-1", false, true);
	assert.equal(history.getAttribute("aria-busy"), "true");
	assert.equal(busyAttributeWrites, 1);

	feed.update(messages(), "assistant-1", false, false);
	assert.equal(history.getAttribute("aria-busy"), "true");
	assert.equal(busyAttributeWrites, 1);

	feed.update(messages(), null, false, false);
	assert.equal(history.getAttribute("aria-busy"), "false");
	assert.equal(busyAttributeWrites, 2);

	feed.destroy();
});

test("desktop feed listens only to the scroll area", () => {
	const { feed, scrollListenerCounts } = createFeedHarness();

	assert.deepEqual(scrollListenerCounts(), { scrollArea: 1, window: 0 });
	feed.destroy();
	assert.deepEqual(scrollListenerCounts(), { scrollArea: 0, window: 0 });
});

test("mobile feed listens only to window scroll", () => {
	const { feed, scrollListenerCounts } = createFeedHarness({ mobile: true });

	assert.deepEqual(scrollListenerCounts(), { scrollArea: 0, window: 1 });
	feed.destroy();
	assert.deepEqual(scrollListenerCounts(), { scrollArea: 0, window: 0 });
});

test("feed swaps scroll listener targets when the mobile query changes", () => {
	const { feed, scrollListenerCounts, triggerMediaChange } = createFeedHarness();

	assert.deepEqual(scrollListenerCounts(), { scrollArea: 1, window: 0 });

	triggerMediaChange(true);
	assert.deepEqual(scrollListenerCounts(), { scrollArea: 0, window: 1 });

	triggerMediaChange(false);
	assert.deepEqual(scrollListenerCounts(), { scrollArea: 1, window: 0 });

	feed.destroy();
	assert.deepEqual(scrollListenerCounts(), { scrollArea: 0, window: 0 });
});

test("feed resets scroll position baseline when swapping scroll targets", () => {
	const { feed, root, frameCount, flushFrames, scrollCalls, triggerMediaChange } = createFeedHarness();
	const scrollArea = root.querySelector<HTMLElement>(".mur-chat-scroll-area");
	assert.ok(scrollArea);
	const currentMessages = messages();

	feed.update(currentMessages, null, false, false);
	flushFrames();
	scrollCalls.length = 0;

	setScrollMetrics(scrollArea, { scrollTop: 400, scrollHeight: 500, clientHeight: 100 });
	scrollArea.dispatchEvent(new window.Event("scroll"));

	setWindowScrollMetrics({ scrollTop: 100, scrollHeight: 1000, clientHeight: 500 });
	triggerMediaChange(true);
	window.dispatchEvent(new window.Event("scroll"));

	feed.update(currentMessages, null, false, false);

	assert.equal(frameCount(), 1);

	feed.destroy();
});

test("mobile generation scrolls the window", () => {
	const { feed, frameCount, flushFrames, scrollCalls, windowScrollCalls } = createFeedHarness({ mobile: true });

	feed.update(messages(), "assistant-1", false, true);

	assert.equal(frameCount(), 1);
	flushFrames();
	assert.deepEqual(scrollCalls, []);
	assert.deepEqual(windowScrollCalls, ["smooth"]);

	feed.destroy();
});

test("streaming update does not downgrade a pending smooth scroll", () => {
	const { feed, frameCount, flushFrames, scrollCalls } = createFeedHarness();
	const currentMessages = messages();

	feed.update(currentMessages, "assistant-1", false, true);
	feed.update(currentMessages, "assistant-1", false, false);

	assert.equal(frameCount(), 1);
	flushFrames();
	assert.deepEqual(scrollCalls, ["smooth"]);

	feed.destroy();
});

test("resize observer scrolls through the scheduler", () => {
	const { feed, frameCount, flushFrames, scrollCalls, triggerResize } = createFeedHarness({ resizeObserver: true });

	triggerResize();

	assert.equal(frameCount(), 1);
	assert.deepEqual(scrollCalls, []);
	flushFrames();
	assert.deepEqual(scrollCalls, ["auto"]);

	feed.destroy();
});

test("resize observer does not replace a pending render scroll", () => {
	const { feed, frameCount, flushFrames, scrollCalls, triggerResize } = createFeedHarness({ resizeObserver: true });

	feed.update(messages(), "assistant-1", false, true);
	triggerResize();

	assert.equal(frameCount(), 1);
	assert.deepEqual(scrollCalls, []);
	flushFrames();
	assert.deepEqual(scrollCalls, ["smooth"]);

	feed.destroy();
});

test("loading a session resets sticky bottom intent", () => {
	const { feed, root, frameCount, flushFrames, scrollCalls } = createFeedHarness();
	const scrollArea = root.querySelector<HTMLElement>(".mur-chat-scroll-area");
	assert.ok(scrollArea);

	feed.update(messages(), null, false, false);
	flushFrames();
	scrollCalls.length = 0;

	setScrollMetrics(scrollArea, { scrollTop: 400, scrollHeight: 500, clientHeight: 100 });
	scrollArea.dispatchEvent(new window.Event("scroll"));
	setScrollMetrics(scrollArea, { scrollTop: 100, scrollHeight: 500, clientHeight: 100 });
	scrollArea.dispatchEvent(new window.Event("scroll"));

	feed.update(messages(), null, false, false);
	assert.equal(frameCount(), 0);

	feed.update([], null, true, false);
	feed.update(
		[
			{
				id: "new-user-1",
				role: "user",
				blocks: [{ id: "new-user-1-text", type: "text", text: "New chat" }],
			},
		],
		null,
		false,
		false,
	);

	assert.equal(frameCount(), 1);
	flushFrames();
	assert.deepEqual(scrollCalls, ["smooth"]);

	feed.destroy();
});

test("global errors without a message id are ignored by the feed", () => {
	const { feed, root } = createFeedHarness();

	feed.update(messages(), null, false, false, { message: "Chat not found. Started a new one." });

	assert.equal(root.querySelector(".mur-message-error"), null);

	feed.destroy();
});

test("text blocks render markdown directly into the block container", async () => {
	const { feed, root } = createFeedHarness();

	feed.update(
		[
			{
				id: "assistant-1",
				role: "assistant",
				blocks: [{ id: "text-1", type: "text", text: "Hello **world**" }],
			},
		],
		null,
		false,
		false,
	);
	await flushMicrotasks();

	const block = root.querySelector<HTMLElement>(".mur-block-text");
	assert.ok(block);
	assert.equal(block.querySelector(".mur-message-content"), null);
	assert.equal(block.firstElementChild?.tagName, "P");
	assert.match(block.textContent ?? "", /Hello world/);

	feed.destroy();
});

test("copy action reads the latest message for a reused node", async () => {
	const { feed, root } = createFeedHarness({ plugins: [CopyPlugin()] });
	const copied: string[] = [];

	setGlobal("navigator", {
		clipboard: {
			writeText: async (text: string) => {
				copied.push(text);
			},
		},
	});

	feed.update(
		[
			{
				id: "assistant-1",
				role: "assistant",
				blocks: [{ id: "text-1", type: "text", text: "Old text" }],
			},
		],
		null,
		false,
		false,
	);

	const copyBtn = root.querySelector<HTMLButtonElement>(".mur-action-icon-btn");
	assert.ok(copyBtn);

	feed.update(
		[
			{
				id: "assistant-1",
				role: "assistant",
				blocks: [{ id: "text-2", type: "text", text: "New text" }],
			},
		],
		null,
		false,
		false,
	);

	copyBtn.click();
	await flushMicrotasks();

	assert.deepEqual(copied, ["New text"]);

	feed.destroy();
});
test("message actions are shown again when they become applicable", () => {
	const { feed, root } = createFeedHarness({ plugins: [CopyPlugin()] });

	setGlobal("navigator", {
		clipboard: {
			writeText: async () => {},
		},
	});

	feed.update(
		[
			{
				id: "assistant-1",
				role: "assistant",
				blocks: [{ id: "text-1", type: "text", text: "Text" }],
			},
		],
		null,
		false,
		false,
	);

	const actions = root.querySelector<HTMLElement>(".mur-message-actions");
	assert.ok(actions);

	feed.update([{ id: "assistant-1", role: "assistant", blocks: [] }], null, false, false);
	assert.equal(actions.hidden, true);

	feed.update(
		[
			{
				id: "assistant-1",
				role: "assistant",
				blocks: [{ id: "text-2", type: "text", text: "Text again" }],
			},
		],
		null,
		false,
		false,
	);

	assert.equal(actions.hidden, false);

	feed.destroy();
});

test("plugin action buttons are initialized once for a message node", () => {
	let callCount = 0;
	const plugin: ChatPlugin = {
		name: "share",
		getActionButtons: () => {
			callCount++;
			return [
				{
					id: "share",
					title: "Share",
					iconHtml: "<span>S</span>",
					onClick: () => {},
				},
			];
		},
	};
	const { feed, root } = createFeedHarness({ plugins: [plugin] });

	feed.update(
		[{ id: "user-1", role: "user", blocks: [{ id: "text-1", type: "text", text: "Old text" }] }],
		null,
		false,
		false,
	);
	feed.update(
		[{ id: "user-1", role: "user", blocks: [{ id: "text-2", type: "text", text: "New text" }] }],
		null,
		false,
		false,
	);

	assert.equal(callCount, 1);
	assert.equal(root.querySelectorAll(".mur-action-icon-btn").length, 1);

	feed.destroy();
});

test("plugin action buttons wait for generation to finish before initialization", () => {
	let callCount = 0;
	const plugin: ChatPlugin = {
		name: "tool-output",
		getActionButtons: (msg) => {
			callCount++;
			const hasToolCall = msg.blocks.some((block) => block.type === "tool_call");
			return hasToolCall
				? [
						{
							id: "view-output",
							title: "View output",
							iconHtml: "<span>O</span>",
							onClick: () => {},
						},
					]
				: [];
		},
	};
	const { feed, root } = createFeedHarness({ plugins: [plugin] });

	feed.update(
		[{ id: "assistant-1", role: "assistant", blocks: [{ id: "text-1", type: "text", text: "Working" }] }],
		"assistant-1",
		false,
		false,
	);

	assert.equal(callCount, 0);
	assert.equal(root.querySelector(".mur-message-actions"), null);

	feed.update(
		[
			{
				id: "assistant-1",
				role: "assistant",
				blocks: [
					{ id: "text-1", type: "text", text: "Working" },
					{
						id: "tool-1",
						type: "tool_call",
						toolCallId: "call-1",
						name: "render_chart",
						argsText: "{}",
						status: "complete",
					},
				],
			},
		],
		null,
		false,
		false,
	);

	assert.equal(callCount, 1);
	assert.equal(root.querySelector<HTMLButtonElement>("[data-action-id='view-output']")?.title, "View output");

	feed.destroy();
});

test("plugin action clicks receive the latest message and DOM context", () => {
	const clicks: MessageActionContext[] = [];
	const plugin: ChatPlugin = {
		name: "share",
		getActionButtons: () => [
			{
				id: "share",
				title: "Share",
				iconHtml: "<span>S</span>",
				onClick: (ctx) => {
					clicks.push(ctx);
				},
			},
		],
	};
	const { feed, root } = createFeedHarness({ plugins: [plugin] });

	feed.update(
		[{ id: "user-1", role: "user", blocks: [{ id: "text-1", type: "text", text: "Old text" }] }],
		null,
		false,
		false,
	);
	const button = root.querySelector<HTMLButtonElement>(".mur-action-icon-btn");
	assert.ok(button);

	feed.update(
		[{ id: "user-1", role: "user", blocks: [{ id: "text-2", type: "text", text: "New text" }] }],
		null,
		false,
		false,
	);

	button.click();

	assert.equal(clicks.length, 1);
	assert.equal(clicks[0].message.blocks[0].id, "text-2");
	assert.equal(clicks[0].buttonEl, button);
	assert.equal(clicks[0].messageEl, root.querySelector(".mur-message"));
	assert.equal(clicks[0].actionId, "share");
	assert.equal(clicks[0].pluginName, "share");

	feed.destroy();
});

test("empty plugin action definitions do not create an action bar", () => {
	const plugin: ChatPlugin = {
		name: "empty",
		getActionButtons: () => [],
	};
	const { feed, root } = createFeedHarness({ plugins: [plugin] });

	feed.update(
		[{ id: "user-1", role: "user", blocks: [{ id: "text-1", type: "text", text: "Hello" }] }],
		null,
		false,
		false,
	);

	assert.equal(root.querySelector(".mur-message-actions"), null);

	feed.destroy();
});

test("edit plugin action opens the editor and saves changes", () => {
	const saved: { id: string; text: string }[] = [];
	const { feed, root } = createFeedHarness({
		plugins: [EditPlugin({ onSave: (id, text) => saved.push({ id, text }) })],
	});

	feed.update(
		[{ id: "user-1", role: "user", blocks: [{ id: "text-1", type: "text", text: "Original text" }] }],
		null,
		false,
		false,
	);

	const editButton = root.querySelector<HTMLButtonElement>("[data-action-id='edit']");
	assert.ok(editButton);
	assert.equal(root.querySelector(".mur-edit-container"), null);

	editButton.click();

	assert.ok(root.querySelector(".mur-edit-container"));
	const textarea = root.querySelector<HTMLTextAreaElement>(".mur-edit-textarea");
	const saveButton = root.querySelector<HTMLButtonElement>(".mur-save-edit-btn");
	assert.ok(textarea);
	assert.ok(saveButton);
	assert.equal(textarea.value, "Original text");

	textarea.value = "Updated text";
	saveButton.click();

	assert.deepEqual(saved, [{ id: "user-1", text: "Updated text" }]);
	assert.equal(root.querySelector(".mur-edit-textarea"), null);

	feed.destroy();
});

test("message-scoped errors render only on the matching message", () => {
	const { feed, root } = createFeedHarness();

	feed.update(messages(), "assistant-1", false, false, { message: "Provider failed", id: "assistant-1" });

	const errors = root.querySelectorAll(".mur-message-error");
	assert.equal(errors.length, 1);
	assert.match(errors[0].textContent ?? "", /Provider failed/);
	assert.equal(errors[0].closest(".mur-message")?.classList.contains("mur-message-assistant"), true);

	feed.destroy();
});
