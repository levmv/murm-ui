import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { Message } from "../core/types";
import { Feed } from "./feed";

interface FeedHarness {
	feed: Feed;
	root: HTMLElement;
	frameCount: () => number;
	flushFrames: () => void;
	scrollCalls: ScrollBehavior[];
	triggerResize: () => void;
}

function setGlobal(name: string, value: unknown): void {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
		writable: true,
	});
}

function createFeedHarness(options: { resizeObserver?: boolean } = {}): FeedHarness {
	const dom = new JSDOM(`
		<div class="mur-chat-scroll-area">
			<div class="mur-chat-history"></div>
		</div>
	`);

	const frames = new Map<number, FrameRequestCallback>();
	let nextFrameId = 1;
	const scrollCalls: ScrollBehavior[] = [];
	let resizeCallback: ResizeObserverCallback | null = null;

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

	dom.window.HTMLElement.prototype.scrollTo = (options?: ScrollToOptions | number) => {
		if (typeof options === "object" && options?.behavior) {
			scrollCalls.push(options.behavior);
		}
	};

	const feed = new Feed(dom.window.document.body, { plugins: [] });

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
		triggerResize: () => {
			assert.ok(resizeCallback);
			resizeCallback([], {} as ResizeObserver);
		},
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

test("generation start schedules one smooth scroll", () => {
	const { feed, frameCount, flushFrames, scrollCalls } = createFeedHarness();

	feed.update(messages(), "assistant-1", false, true);

	assert.equal(frameCount(), 1);
	flushFrames();
	assert.deepEqual(scrollCalls, ["smooth"]);

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

test("global errors without a message id are ignored by the feed", () => {
	const { feed, root } = createFeedHarness();

	feed.update(messages(), null, false, false, { message: "Chat not found. Started a new one." });

	assert.equal(root.querySelector(".mur-message-error"), null);

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
