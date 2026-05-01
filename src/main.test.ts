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
	RequestOptions,
	StreamEvent,
} from "./core/types";

class MemoryStorage implements ChatStorage {
	public sessions = new Map<string, ChatSession>();
	public loadSessionsCalls = 0;

	constructor(sessions: ChatSession[] = []) {
		for (const session of sessions) {
			this.sessions.set(session.id, session);
		}
	}

	async loadSessions(limit: number): Promise<PaginatedSessions> {
		this.loadSessionsCalls++;
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

function installDom(url = "https://example.test/"): HTMLElement {
	const dom = new JSDOM(renderShell(), {
		pretendToBeVisual: true,
		url,
	});

	const requestAnimationFrame = (callback: FrameRequestCallback) => {
		return dom.window.setTimeout(() => callback(Date.now()), 0);
	};

	Object.defineProperty(dom.window, "matchMedia", {
		configurable: true,
		value: (query: string) =>
			({
				matches: false,
				media: query,
				onchange: null,
				addEventListener: () => {},
				removeEventListener: () => {},
				addListener: () => {},
				removeListener: () => {},
				dispatchEvent: () => false,
			}) as MediaQueryList,
	});
	delete (dom.window as unknown as Window & { ontouchstart?: unknown }).ontouchstart;

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

	return dom.window.document.querySelector(".mur-app") as HTMLElement;
}

function renderShell(): string {
	return `
		<div class="mur-app">
			<aside class="mur-sidebar">
				<div class="mur-sidebar-header">
					<button type="button" class="mur-close-sidebar-btn">Close</button>
				</div>
				<div class="mur-sidebar-actions">
					<button type="button" class="mur-new-chat-btn">New Chat</button>
				</div>
				<div class="mur-sidebar-content"></div>
				<div class="mur-sidebar-footer"></div>
			</aside>
			<main class="mur-main-area">
				<header class="mur-main-header">
					<button type="button" class="mur-open-sidebar-btn">Open</button>
					<h2 class="mur-header-title">New Chat</h2>
				</header>
				<div class="mur-chat-layout-wrapper">
					<div class="mur-chat-scroll-area">
						<div class="mur-chat-history" role="log" aria-live="polite" aria-atomic="false"></div>
					</div>
					<div class="mur-chat-form-container">
						<form class="mur-chat-form">
							<textarea class="mur-chat-input" rows="1"></textarea>
							<button type="submit" class="mur-send-btn">Send</button>
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
	let inputContextIsComplete = false;

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
		onInputMount: (ctx) => {
			lifecycle.push("input");
			inputContextIsComplete =
				ctx.container === container &&
				ctx.form === container.querySelector(".mur-chat-form") &&
				ctx.input === container.querySelector(".mur-chat-input") &&
				typeof ctx.requestSubmitStateSync === "function";
		},
		onUserSubmit: (message) => {
			message.meta = { fromPlugin: true };
		},
		destroy: () => lifecycle.push("destroy"),
	};
	const storage = new MemoryStorage();
	assert.equal(document.documentElement.classList.contains("mur-chat-page-scroll"), false);

	const ui = new ChatUI({
		container,
		enableSidebar: false,
		provider,
		routing: false,
		storage,
		plugins: () => [plugin],
	});
	assert.equal(document.documentElement.classList.contains("mur-chat-page-scroll"), true);

	await waitFor(() => !ui.engine.state.isLoadingSession, "initial load");
	assert.equal(storage.loadSessionsCalls, 0);
	assert.deepEqual(lifecycle, ["mount", "input"]);
	assert.equal(inputContextIsComplete, true);

	const input = container.querySelector(".mur-chat-input") as HTMLTextAreaElement;
	const form = container.querySelector(".mur-chat-form") as HTMLFormElement;

	input.value = "hello";
	submit(form);
	await waitFor(() => providerCalls === 1 && ui.engine.state.generatingMessageId === null, "first reply");

	assert.equal(providerMessages[0][0].meta?.fromPlugin, true);
	assert.match(container.querySelector(".mur-chat-history")?.textContent ?? "", /hello back/);

	input.value = "second";
	submit(form);
	await waitFor(() => providerCalls === 2 && ui.engine.state.generatingMessageId !== null, "second stream");
	assert.equal(container.querySelector(".mur-send-btn")?.classList.contains("mur-generating"), true);

	submit(form);
	await waitFor(() => latestSignal?.aborted === true && ui.engine.state.generatingMessageId === null, "stop");

	await ui.destroy();
	assert.equal(document.documentElement.classList.contains("mur-chat-page-scroll"), false);
	assert.deepEqual(lifecycle, ["mount", "input", "destroy"]);

	input.value = "after destroy";
	submit(form);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(providerCalls, 2);
});

test("ChatUI passes titleOptions into auto-title generation", async () => {
	const container = installDom();
	const { ChatUI } = await import("./main");
	let titleOptions: RequestOptions = {};
	const provider: ChatProvider = {
		async streamChat(_messages, _options, _signal, onEvent: (event: StreamEvent) => void): Promise<void> {
			onEvent({ type: "text_delta", messageId: "assistant-1", blockId: "reply", delta: "hello back" });
			onEvent({ type: "finish", reason: "stop" });
		},
		async generateTitle(_messages, options): Promise<string> {
			titleOptions = options ?? {};
			return "Smart Title";
		},
	};
	const ui = new ChatUI({
		container,
		enableSidebar: false,
		provider,
		routing: false,
		storage: new MemoryStorage(),
		titleOptions: { model: "title-model", temperature: 0.1 },
	});

	await waitFor(() => !ui.engine.state.isLoadingSession, "initial load");
	const input = container.querySelector(".mur-chat-input") as HTMLTextAreaElement;
	const form = container.querySelector(".mur-chat-form") as HTMLFormElement;
	input.value = "hello";
	submit(form);
	await waitFor(() => titleOptions.model === "title-model", "auto-title options");

	assert.equal(titleOptions.temperature, 0.1);
	await ui.destroy();
});

test("ChatUI marks the app layout when the chat is empty", async () => {
	const container = installDom();
	const { ChatUI } = await import("./main");
	const ui = new ChatUI({
		container,
		enableSidebar: false,
		provider: {
			async streamChat(_messages, _options, _signal, onEvent: (event: StreamEvent) => void): Promise<void> {
				onEvent({ type: "finish", reason: "stop" });
			},
		},
		routing: false,
		storage: new MemoryStorage(),
	});

	await waitFor(() => !ui.engine.state.isLoadingSession, "initial load");

	assert.equal(container.classList.contains("mur-chat-empty"), true);

	await ui.engine.setMessages([textMessage("msg-1", "user", "hello")]);
	assert.equal(container.classList.contains("mur-chat-empty"), false);

	await ui.engine.setMessages([]);
	assert.equal(container.classList.contains("mur-chat-empty"), true);

	await ui.destroy();
});

test("ChatUI keeps the non-empty layout state while switching between stored chats", async () => {
	const container = installDom();
	const { ChatUI } = await import("./main");

	let releaseLoad!: () => void;
	const loadReleased = new Promise<void>((resolve) => {
		releaseLoad = resolve;
	});
	let delayedLoadStarted = false;

	const storage = new (class extends MemoryStorage {
		override async loadOne(id: string): Promise<ChatSession | null> {
			if (id === "chat-2") {
				delayedLoadStarted = true;
				await loadReleased;
			}
			return super.loadOne(id);
		}
	})([
		{
			id: "chat-1",
			title: "Stored Chat 1",
			updatedAt: 200,
			messages: [textMessage("msg-1", "user", "stored one")],
		},
		{
			id: "chat-2",
			title: "Stored Chat 2",
			updatedAt: 100,
			messages: [textMessage("msg-2", "user", "stored two")],
		},
	]);

	const ui = new ChatUI({
		container,
		provider: {
			async streamChat(_messages, _options, _signal, onEvent: (event: StreamEvent) => void): Promise<void> {
				onEvent({ type: "finish", reason: "stop" });
			},
		},
		routing: false,
		storage,
	});

	await waitFor(() => !ui.engine.state.isLoadingSessions, "stored history load");
	await ui.engine.sessions.switch("chat-1");
	await waitFor(
		() => !ui.engine.state.isLoadingSession && ui.engine.state.currentSessionId === "chat-1",
		"chat 1 load",
	);

	assert.equal(container.classList.contains("mur-chat-empty"), false);

	const switchPromise = ui.engine.sessions.switch("chat-2");
	await waitFor(() => delayedLoadStarted && ui.engine.state.isLoadingSession, "chat 2 load start");

	assert.deepEqual(ui.engine.state.messages, []);
	assert.equal(container.classList.contains("mur-chat-empty"), false);

	releaseLoad();
	await switchPromise;

	assert.equal(container.classList.contains("mur-chat-empty"), false);

	await ui.destroy();
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

	await waitFor(() => !ui.engine.state.isLoadingSessions, "stored history load");
	assert.equal(container.querySelector(".mur-header-title")?.textContent, "New Chat");
	assert.equal(container.querySelector(".mur-sidebar-item-link")?.textContent, "Stored Chat");

	const sidebar = container.querySelector(".mur-sidebar") as HTMLElement;
	const closeBtn = container.querySelector(".mur-close-sidebar-btn") as HTMLButtonElement;
	const openBtn = container.querySelector(".mur-open-sidebar-btn") as HTMLButtonElement;
	const storedChatLink = container.querySelector(".mur-sidebar-item-link") as HTMLAnchorElement;
	const previousSessionId = ui.engine.state.currentSessionId;

	closeBtn.click();
	assert.equal(sidebar.classList.contains("mur-hidden-desktop"), true);
	assert.equal(container.classList.contains("mur-sidebar-closed"), true);

	openBtn.click();
	assert.equal(sidebar.classList.contains("mur-hidden-desktop"), false);
	assert.equal(container.classList.contains("mur-sidebar-closed"), false);

	storedChatLink.click();
	await waitFor(() => ui.engine.state.currentSessionId === "chat-1", "stored session selection");
	assert.equal(container.querySelector(".mur-header-title")?.textContent, "Stored Chat");

	(container.querySelector(".mur-new-chat-btn") as HTMLButtonElement).click();
	assert.notEqual(ui.engine.state.currentSessionId, previousSessionId);

	await ui.destroy();
});

test("ChatUI keeps the input available while switching chats", async () => {
	const container = installDom();
	const { ChatUI } = await import("./main");

	let releaseLoad!: () => void;
	const loadReleased = new Promise<void>((resolve) => {
		releaseLoad = resolve;
	});

	const storage = new (class extends MemoryStorage {
		override async loadOne(id: string): Promise<ChatSession | null> {
			await loadReleased;
			return super.loadOne(id);
		}
	})([
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

	await waitFor(() => !ui.engine.state.isLoadingSessions, "stored history load");

	const input = container.querySelector(".mur-chat-input") as HTMLTextAreaElement;
	let focusCalls = 0;
	input.focus = (() => {
		focusCalls++;
	}) as HTMLTextAreaElement["focus"];

	(container.querySelector(".mur-sidebar-item-link") as HTMLAnchorElement).click();
	await waitFor(() => ui.engine.state.isLoadingSession, "stored session load start");
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(input.disabled, false);
	assert.equal(focusCalls, 1);

	releaseLoad();

	await waitFor(() => !ui.engine.state.isLoadingSession, "stored session load");
	await waitFor(() => focusCalls === 1, "input focus after session load");

	await ui.destroy();
});

test("ChatUI shows dismissible global errors outside the feed", async (t) => {
	t.mock.method(console, "error", () => {});

	const container = installDom();
	const { ChatUI } = await import("./main");

	const provider: ChatProvider = {
		async streamChat(): Promise<void> {
			throw new Error("Provider failed");
		},
	};

	const ui = new ChatUI({
		container,
		enableSidebar: false,
		initialSessionId: "missing-chat",
		provider,
		routing: false,
		storage: new MemoryStorage(),
	});

	await waitFor(() => !ui.engine.state.isLoadingSession, "missing session fallback");

	const error = container.querySelector(".mur-global-error") as HTMLElement;
	const closeButton = container.querySelector(".mur-global-error-close") as HTMLButtonElement;
	assert.ok(error);

	assert.equal(error.hidden, false);
	assert.match(error.textContent ?? "", /Chat not found/);
	assert.doesNotMatch(container.querySelector(".mur-chat-history")?.textContent ?? "", /Chat not found/);

	closeButton.click();

	assert.equal(ui.engine.state.error, null);
	assert.equal(error.hidden, true);

	const input = container.querySelector(".mur-chat-input") as HTMLTextAreaElement;
	const form = container.querySelector(".mur-chat-form") as HTMLFormElement;
	input.value = "hello";
	submit(form);

	await waitFor(() => ui.engine.state.error?.id !== undefined, "message-scoped provider error");

	assert.equal(error.hidden, true);

	await ui.destroy();
});

test("ChatUI replaces an invalid routed chat URL with the blank chat URL", async (t) => {
	t.mock.method(console, "error", () => {});

	const container = installDom("https://example.test/#/chat/missing-chat");
	const { ChatUI } = await import("./main");

	const provider: ChatProvider = {
		async streamChat(_messages, _options, _signal, onEvent: (event: StreamEvent) => void): Promise<void> {
			onEvent({ type: "finish", reason: "stop" });
		},
	};

	const ui = new ChatUI({
		container,
		provider,
		storage: new MemoryStorage([
			{
				id: "latest",
				title: "Latest chat",
				updatedAt: 200,
				messages: [textMessage("latest-user", "user", "new question")],
			},
		]),
	});

	await waitFor(() => !ui.engine.state.isLoadingSession, "invalid routed chat fallback");

	assert.equal(window.location.hash, "#/");
	assert.notEqual(ui.engine.state.currentSessionId, "missing-chat");
	assert.deepEqual(ui.engine.state.messages, []);
	assert.match(container.querySelector(".mur-global-error")?.textContent ?? "", /Chat not found/);

	await ui.destroy();
});

test("ChatUI keeps a blank route when initial history loads without a URL id", async () => {
	const container = installDom("https://example.test/");
	const { ChatUI } = await import("./main");

	let releaseLoad!: () => void;
	const loadReleased = new Promise<void>((resolve) => {
		releaseLoad = resolve;
	});

	let loadStarted!: () => void;
	const loadStartedPromise = new Promise<void>((resolve) => {
		loadStarted = resolve;
	});

	const storage = new (class extends MemoryStorage {
		override async loadSessions(limit: number): Promise<PaginatedSessions> {
			loadStarted();
			await loadReleased;
			return super.loadSessions(limit);
		}
	})([
		{
			id: "latest",
			title: "Latest chat",
			updatedAt: 200,
			messages: [textMessage("latest-user", "user", "new question")],
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
		storage,
	});

	await loadStartedPromise;
	assert.equal(ui.engine.state.isLoadingSession, false);
	assert.equal(ui.engine.state.isLoadingSessions, true);
	assert.equal(window.location.hash, "");
	assert.match(container.querySelector(".mur-sidebar-content")?.textContent ?? "", /Loading chats/);

	releaseLoad();
	await waitFor(() => !ui.engine.state.isLoadingSessions, "stored history load");

	assert.notEqual(ui.engine.state.currentSessionId, "latest");
	assert.deepEqual(ui.engine.state.messages, []);
	assert.equal(window.location.hash, "");

	await ui.destroy();
});
