import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type {
	ChatPlugin,
	ChatProvider,
	ChatSession,
	ChatStorage,
	Message,
	PaginatedSessions,
	StreamEvent,
} from "./core/types";

class MemoryStorage implements ChatStorage {
	public sessions = new Map<string, ChatSession>();

	constructor(sessions: ChatSession[] = []) {
		for (const session of sessions) {
			this.sessions.set(session.id, session);
		}
	}

	async loadSessions(limit: number): Promise<PaginatedSessions> {
		const items = [...this.sessions.values()]
			.sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
			.slice(0, limit)
			.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));

		return { items, hasMore: this.sessions.size > limit };
	}

	async loadOne(id: string): Promise<ChatSession | null> {
		return this.sessions.get(id) ?? null;
	}

	async save(session: ChatSession): Promise<void> {
		this.sessions.set(session.id, session);
	}

	async delete(id: string): Promise<void> {
		this.sessions.delete(id);
	}
}

function setGlobal(name: string, value: unknown): void {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
		writable: true,
	});
}

function installDom(): HTMLElement {
	const dom = new JSDOM(renderShell(), {
		pretendToBeVisual: true,
		url: "https://example.test/",
	});

	const requestAnimationFrame = (callback: FrameRequestCallback) => {
		return dom.window.setTimeout(() => callback(Date.now()), 0);
	};

	Object.defineProperty(dom.window, "matchMedia", {
		configurable: true,
		value: () => ({ matches: false }),
	});

	class MockIntersectionObserver {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	}

	dom.window.HTMLElement.prototype.scrollTo = () => {};

	setGlobal("window", dom.window);
	setGlobal("document", dom.window.document);
	setGlobal("navigator", dom.window.navigator);
	setGlobal("history", dom.window.history);
	setGlobal("location", dom.window.location);
	setGlobal("localStorage", dom.window.localStorage);
	setGlobal("DOMParser", dom.window.DOMParser);
	setGlobal("Node", dom.window.Node);
	setGlobal("NodeFilter", dom.window.NodeFilter);
	setGlobal("HTMLElement", dom.window.HTMLElement);
	setGlobal("MouseEvent", dom.window.MouseEvent);
	setGlobal("SubmitEvent", dom.window.SubmitEvent);
	setGlobal("IntersectionObserver", MockIntersectionObserver);
	setGlobal("requestAnimationFrame", requestAnimationFrame);
	setGlobal("cancelAnimationFrame", dom.window.clearTimeout.bind(dom.window));
	setGlobal("CSS", { supports: () => false });

	return dom.window.document.querySelector(".llm-app") as HTMLElement;
}

function renderShell(): string {
	return `
		<div class="llm-app">
			<aside class="llm-sidebar">
				<div class="sidebar-header">
					<button type="button" class="llm-close-sidebar-btn">Close</button>
				</div>
				<div class="sidebar-actions">
					<button type="button" class="llm-new-chat-btn">New Chat</button>
				</div>
				<div class="sidebar-content"></div>
				<div class="sidebar-footer"></div>
			</aside>
			<main class="llm-main-area">
				<header class="llm-main-header">
					<button type="button" class="llm-open-sidebar-btn">Open</button>
					<h2 class="llm-header-title">New Chat</h2>
				</header>
				<div class="llm-chat-layout-wrapper">
					<div class="llm-chat-scroll-area">
						<div class="llm-chat-history" role="log" aria-live="polite" aria-atomic="false"></div>
					</div>
					<div class="llm-chat-form-container">
						<form class="llm-chat-form">
							<textarea class="llm-chat-input" rows="1"></textarea>
							<button type="submit" class="llm-send-btn">Send</button>
						</form>
					</div>
				</div>
			</main>
		</div>
	`;
}

function textMessage(id: string, role: "user" | "assistant", text: string): Message {
	return {
		id,
		role,
		blocks: [{ id: `${id}-text`, type: "text", text }],
	};
}

function submit(form: HTMLFormElement): void {
	form.dispatchEvent(new window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
}

async function waitFor(assertion: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 30; i++) {
		if (assertion()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	assert.fail(`Timed out waiting for ${label}`);
}

test("ChatUI mounts, submits, stops, runs plugins, and destroys cleanly", async () => {
	const container = installDom();
	const { ChatUI } = await import("./main");

	let providerCalls = 0;
	let latestSignal: AbortSignal | null = null;
	const providerMessages: Message[][] = [];
	const lifecycle: string[] = [];

	const provider: ChatProvider = {
		async streamChat(messages, _options, signal, onEvent): Promise<void> {
			providerCalls++;
			latestSignal = signal;
			providerMessages.push(messages);

			if (providerCalls === 1) {
				onEvent({ type: "text_delta", messageId: "assistant-1", blockId: "reply", delta: "hello back" });
				onEvent({ type: "finish", reason: "stop" });
				return;
			}

			await new Promise<void>((resolve) => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
		},
	};

	const plugin: ChatPlugin = {
		name: "smoke-plugin",
		onMount: () => lifecycle.push("mount"),
		onInputMount: () => lifecycle.push("input"),
		onUserSubmit: (message) => {
			message.meta = { fromPlugin: true };
		},
		destroy: () => lifecycle.push("destroy"),
	};

	const ui = new ChatUI({
		container,
		enableSidebar: false,
		provider,
		routing: false,
		storage: new MemoryStorage(),
		plugins: () => [plugin],
	});

	await waitFor(() => !ui.engine.store.get().isLoadingSession, "initial load");
	assert.deepEqual(lifecycle, ["mount", "input"]);

	const input = container.querySelector(".llm-chat-input") as HTMLTextAreaElement;
	const form = container.querySelector(".llm-chat-form") as HTMLFormElement;

	input.value = "hello";
	submit(form);
	await waitFor(() => providerCalls === 1 && ui.engine.store.get().generatingMessageId === null, "first reply");

	assert.equal(providerMessages[0][0].meta?.fromPlugin, true);
	assert.match(container.querySelector(".llm-chat-history")?.textContent ?? "", /hello back/);

	input.value = "second";
	submit(form);
	await waitFor(() => providerCalls === 2 && ui.engine.store.get().generatingMessageId !== null, "second stream");
	assert.equal(container.querySelector(".llm-send-btn")?.classList.contains("generating"), true);

	submit(form);
	await waitFor(() => latestSignal?.aborted === true && ui.engine.store.get().generatingMessageId === null, "stop");

	await ui.destroy();
	assert.deepEqual(lifecycle, ["mount", "input", "destroy"]);

	input.value = "after destroy";
	submit(form);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(providerCalls, 2);
});

test("ChatUI wires sidebar controls when the sidebar is enabled", async () => {
	const container = installDom();
	const { ChatUI } = await import("./main");
	const storage = new MemoryStorage([
		{
			id: "chat-1",
			title: "Stored Chat",
			updatedAt: 100,
			messages: [textMessage("msg-1", "user", "stored")],
		},
	]);

	const provider: ChatProvider = {
		async streamChat(_messages, _options, _signal, onEvent: (event: StreamEvent) => void): Promise<void> {
			onEvent({ type: "finish", reason: "stop" });
		},
	};

	const ui = new ChatUI({
		container,
		provider,
		routing: false,
		storage,
	});

	await waitFor(() => !ui.engine.store.get().isLoadingSession, "stored session load");
	assert.equal(container.querySelector(".llm-header-title")?.textContent, "Stored Chat");
	assert.equal(container.querySelector(".sidebar-item-link")?.textContent, "Stored Chat");

	const sidebar = container.querySelector(".llm-sidebar") as HTMLElement;
	const closeBtn = container.querySelector(".llm-close-sidebar-btn") as HTMLButtonElement;
	const openBtn = container.querySelector(".llm-open-sidebar-btn") as HTMLButtonElement;
	const previousSessionId = ui.engine.store.get().currentSessionId;

	closeBtn.click();
	assert.equal(sidebar.classList.contains("hidden-desktop"), true);
	assert.equal(container.classList.contains("sidebar-closed"), true);

	openBtn.click();
	assert.equal(sidebar.classList.contains("hidden-desktop"), false);
	assert.equal(container.classList.contains("sidebar-closed"), false);

	(container.querySelector(".llm-new-chat-btn") as HTMLButtonElement).click();
	assert.notEqual(ui.engine.store.get().currentSessionId, previousSessionId);

	await ui.destroy();
});
