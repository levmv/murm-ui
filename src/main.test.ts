import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { closeDropdown } from "./components/dropdown";
import type { ConversationChange } from "./core/conversation-types";
import type {
	ChatPlugin,
	ChatProvider,
	ChatSession,
	ChatStorage,
	ChatStreamRequest,
	ContentBlock,
	Message,
	PaginatedSessions,
	RendererContext,
	RequestOptions,
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
			.sort((a, b) => {
				const pinnedDelta = Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned));
				if (pinnedDelta !== 0) return pinnedDelta;
				return b.updatedAt - a.updatedAt || b.id.localeCompare(a.id);
			})
			.slice(0, limit)
			.map(({ id, title, updatedAt, isPinned }) => ({
				id,
				title,
				updatedAt,
				...(typeof isPinned === "boolean" ? { isPinned } : {}),
			}));

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

interface ShellOptions {
	includeHeaderTitle?: boolean;
	includeOpenSidebarButton?: boolean;
	rootClass?: string;
}

function setGlobal(name: string, value: unknown): void {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
		writable: true,
	});
}

function installDom(url = "https://example.test/", shellOptions: ShellOptions = {}): HTMLElement {
	const dom = new JSDOM(renderShell(shellOptions), {
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
	setGlobal("Element", dom.window.Element);
	setGlobal("HTMLElement", dom.window.HTMLElement);
	setGlobal("MouseEvent", dom.window.MouseEvent);
	setGlobal("SubmitEvent", dom.window.SubmitEvent);
	setGlobal("IntersectionObserver", MockIntersectionObserver);
	setGlobal("requestAnimationFrame", requestAnimationFrame);
	setGlobal("cancelAnimationFrame", dom.window.clearTimeout.bind(dom.window));
	setGlobal("CSS", { supports: () => false });

	return dom.window.document.querySelector(".mur-app") as HTMLElement;
}

function renderShell(options: ShellOptions = {}): string {
	const includeHeaderTitle = options.includeHeaderTitle ?? true;
	const includeOpenSidebarButton = options.includeOpenSidebarButton ?? true;
	const rootClass = ["mur-app", options.rootClass].filter(Boolean).join(" ");

	return `
		<div class="${rootClass}">
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
					${includeOpenSidebarButton ? '<button type="button" class="mur-open-sidebar-btn">Open</button>' : ""}
					${includeHeaderTitle ? '<h2 class="mur-header-title">New Chat</h2>' : ""}
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

function setInputValue(input: HTMLTextAreaElement, value: string): void {
	input.value = value;
	input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function waitFor(assertion: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 30; i++) {
		if (assertion()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	assert.fail(`Timed out waiting for ${label}`);
}

test("ChatUI mounts, submits, stops, runs plugins, and destroys cleanly", async () => {
	const container = installDom("https://example.test/", { includeOpenSidebarButton: false });
	const { ChatUI } = await import("./main");

	let providerCalls = 0;
	let latestSignal: AbortSignal | null = null;
	const providerMessages: Message[][] = [];
	const lifecycle: string[] = [];
	let inputContextIsComplete = false;

	const provider: ChatProvider = {
		async streamChat(request: ChatStreamRequest, onChange: (changes: ConversationChange[]) => void): Promise<void> {
			providerCalls++;
			latestSignal = request.signal;
			providerMessages.push(request.messages);

			if (providerCalls === 1) {
				onChange([
					{ type: "block.put", messageId: request.messageId, block: { id: "reply", type: "text", text: "hello back" } },
				]);

				return;
			}

			await new Promise<void>((resolve) => {
				request.signal.addEventListener("abort", () => resolve(), { once: true });
			});
		},
	};

	const plugin: ChatPlugin = {
		name: "smoke-plugin",
		onMount: () => lifecycle.push("mount"),
		mountComposer: (ctx) => {
			lifecycle.push("input");
			inputContextIsComplete =
				ctx.container === container &&
				ctx.form === container.querySelector(".mur-chat-form") &&
				ctx.input === container.querySelector(".mur-chat-input") &&
				typeof ctx.changed === "function";
			return { destroy: () => lifecycle.push("input-destroy") };
		},
		destroy: () => lifecycle.push("destroy"),
	};
	const closed = Promise.withResolvers<void>();
	let closeCalls = 0;
	const storage = new (class extends MemoryStorage {
		close(): Promise<void> {
			closeCalls++;
			return closed.promise;
		}
	})();
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

	assert.match(container.querySelector(".mur-chat-history")?.textContent ?? "", /hello back/);

	input.value = "second";
	submit(form);
	await waitFor(() => providerCalls === 2 && ui.engine.state.generatingMessageId !== null, "second stream");
	assert.equal(container.querySelector(".mur-send-btn")?.classList.contains("mur-generating"), true);
	assert.equal(input.readOnly, false);
	setInputValue(input, "next draft");
	input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
	assert.equal((latestSignal as AbortSignal | null)?.aborted, false);

	submit(form);
	await waitFor(() => latestSignal?.aborted === true && ui.engine.state.generatingMessageId === null, "stop");
	assert.equal(input.value, "next draft");

	const closing = ui.destroy();
	assert.equal(ui.destroy(), closing);
	assert.equal(document.documentElement.classList.contains("mur-chat-page-scroll"), false);
	assert.deepEqual(lifecycle, ["mount", "input", "input-destroy", "destroy"]);

	input.value = "after destroy";
	submit(form);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(providerCalls, 2);
	assert.equal(closeCalls, 1);
	closed.reject(new Error("Storage close failed"));
	await assert.rejects(closing, /Storage close failed/);
	assert.deepEqual(lifecycle, ["mount", "input", "input-destroy", "destroy"]);
});

test("ChatUI renders the engine's messages without revisiting history or the composer per token", async (t) => {
	const container = installDom();
	const { ChatUI } = await import("./main");
	let emit!: (changes: ConversationChange[]) => void;
	let messageId = "";
	let runId = "";
	const { promise: done, resolve: finish } = Promise.withResolvers<void>();
	const rendered = new Map<string, { block: ContentBlock; context: RendererContext; visits: number }>();
	const ui = new ChatUI({
		container,
		routing: false,
		enableSidebar: false,
		storage: new MemoryStorage(),
		minAgentRunSteps: Infinity,
		provider: {
			async streamChat(request, onChange) {
				messageId = request.messageId;
				runId = request.runId;
				emit = onChange;
				await done;
			},
		},
		plugins: () => [
			{
				name: "test-0",
				renderers: [
					{
						matches: () => true,
						mount(element) {
							return {
								update(block, context) {
									rendered.set(block.id, {
										block: structuredClone(block),
										context,
										visits: (rendered.get(block.id)?.visits ?? 0) + 1,
									});
									element.textContent = block.type === "text" ? block.text : block.type;
								},
								destroy() {},
							};
						},
					},
				],
			},
		],
	});
	t.after(async () => {
		finish();
		await ui.destroy();
	});
	await ui.engine.setMessages([textMessage("old", "assistant", "History")]);
	ui.engine.sendMessage("Question");
	await waitFor(() => Boolean(emit), "provider");
	emit([{ type: "block.put", messageId, block: { id: "text", type: "text", text: "Start" } }]);
	await waitFor(() => rendered.has("text"), "first stream frame");
	const answer = ui.engine.conversation.getMessage(messageId)!;
	assert.equal(rendered.get("text")!.context.message, answer);
	assert.equal(ui.engine.state.messages, ui.engine.conversation.state.messages);
	const oldNode = container.querySelector(".mur-message")!;
	const oldBlocks = ui.engine.state.messages[0].blocks;
	let historyReads = 0;
	Object.defineProperty(ui.engine.state.messages[0], "blocks", {
		configurable: true,
		get() {
			historyReads++;
			return oldBlocks;
		},
	});
	const observer = new window.MutationObserver(() => {
		controlMutations++;
	});
	let controlMutations = 0;
	observer.observe(container.querySelector(".mur-chat-form-container")!, {
		subtree: true,
		attributes: true,
		childList: true,
		characterData: true,
	});
	const visits = rendered.get("text")!.visits;
	for (let i = 0; i < 100; i++) emit([{ type: "text.append", messageId, blockId: "text", delta: "." }]);
	await waitFor(() => rendered.get("text")!.visits > visits, "coalesced stream frame");
	observer.disconnect();
	assert.equal(rendered.get("text")!.visits, visits + 1);
	assert.equal(historyReads, 0);
	assert.equal(controlMutations, 0);
	assert.equal(container.querySelector(".mur-message"), oldNode);
	assert.deepEqual(rendered.get("text")!.block, { id: "text", type: "text", text: `Start${".".repeat(100)}` });

	emit([
		{ type: "block.put", messageId, block: { id: "thought", type: "reasoning", text: "Plan" } },
		{ type: "text.append", messageId, blockId: "thought", delta: " next" },
		{
			type: "block.put",
			messageId,
			block: { id: "call", type: "tool_call", toolCallId: "call", name: "read", argsText: "", status: "streaming" },
		},
		{ type: "tool.update", messageId, blockId: "call", argsDelta: "{}", status: "complete" },
		{
			type: "message.put",
			message: {
				id: "result",
				role: "tool",
				runId,
				blocks: [{ id: "output", type: "tool_result", toolCallId: "call", outputText: "File contents" }],
			},
		},
	]);
	await waitFor(() => rendered.has("output"), "tool result");
	assert.deepEqual(rendered.get("call")!.block, {
		id: "call",
		type: "tool_call",
		toolCallId: "call",
		name: "read",
		argsText: "{}",
		status: "complete",
	});
	assert.deepEqual(rendered.get("thought")!.block, {
		id: "thought",
		type: "reasoning",
		text: "Plan next",
	});
	assert.equal(rendered.get("output")!.context.message.role, "tool");
	emit([
		{
			type: "message.put",
			message: {
				id: "final",
				role: "assistant",
				runId,
				status: "streaming",
				blocks: [{ id: "final-text", type: "text", text: "Final answer" }],
				usage: { input: 10, output: 20, total: 30 },
			},
		},
	]);
	finish();
	await waitFor(() => rendered.get("final-text")?.context.isGenerating === false, "completed reply");
	assert.deepEqual(rendered.get("final-text")!.context.message.usage, { input: 10, output: 20, total: 30 });
	assert.equal(container.querySelectorAll(".mur-generating").length, 0);
});

test("ChatUI keeps a pending history page through live updates and preserves message order", async (t) => {
	const container = installDom();
	const { ChatUI } = await import("./main");
	let release!: (page: { messages: Message[]; hasMore: boolean }) => void;
	const storage = new (class extends MemoryStorage {
		async loadOlderMessages() {
			return await new Promise<{ messages: Message[]; hasMore: boolean }>((resolve) => {
				release = resolve;
			});
		}
	})([
		{
			id: "chat",
			title: "Chat",
			updatedAt: 1,
			messages: [textMessage("recent", "assistant", "Recent")],
			hasMoreMessages: true,
			nextOlderMessagesCursor: "page",
		},
	]);
	const ui = new ChatUI({
		container,
		routing: false,
		enableSidebar: false,
		initialSessionId: "chat",
		storage,
		provider: {
			async streamChat(request, onChange) {
				onChange([
					{
						type: "block.put",
						messageId: request.messageId,
						block: { id: "reply-text", type: "text", text: "Live reply" },
					},
				]);
			},
		},
	});
	t.after(() => ui.destroy());
	await waitFor(() => container.querySelector(".mur-chat-history")!.textContent!.includes("Recent"), "initial history");
	const history = container.querySelector(".mur-chat-history")!;
	const recent = history.firstElementChild;
	const scroll = container.querySelector<HTMLElement>(".mur-chat-scroll-area")!;
	Object.defineProperties(scroll, { scrollHeight: { value: 2000 }, clientHeight: { value: 200 } });
	for (const top of [800, 100]) {
		scroll.scrollTop = top;
		scroll.dispatchEvent(new window.Event("scroll"));
	}
	await waitFor(() => Boolean(release), "older page request");
	ui.engine.sendMessage("New question");
	await waitFor(() => history.textContent!.includes("Live reply"), "live reply while loading history");
	assert.equal(container.querySelector<HTMLElement>(".mur-feed-spinner-top")!.hidden, false);
	release({
		messages: [textMessage("older", "assistant", "Older"), textMessage("recent", "assistant", "Stale")],
		hasMore: false,
	});
	await waitFor(() => history.textContent!.includes("Older"), "prepended page");
	assert.equal(history.children[1], recent);
	assert.match(history.textContent!, /Older\s*Recent\s*New question\s*Live reply/);
	assert.equal(container.querySelector<HTMLElement>(".mur-feed-spinner-top")!.hidden, true);

	const messages = ui.engine.state.messages;
	messages.reverse();
	messages.splice(1, 1);
	await ui.engine.setMessages(messages);
	await waitFor(() => /^Live reply\s*Recent\s*Older/.test(history.textContent!), "replacement order");
	assert.equal(history.querySelectorAll(".mur-message").length, 3);
});

test("ChatUI accepts file-only input through its composer plugin", async (t) => {
	const container = installDom();
	const { ChatUI } = await import("./main");
	const { AttachmentPlugin } = await import("./plugins/attachment/attachment-plugin");
	const form = container.querySelector<HTMLFormElement>("form")!;
	let sent: Message[] | undefined;
	const ui = new ChatUI({
		container,
		routing: false,
		enableSidebar: false,
		storage: new MemoryStorage(),
		provider: {
			async streamChat(request) {
				sent = request.messages;
			},
		},
		plugins: () => [
			AttachmentPlugin({
				onAttach: ({ file }) => ({
					id: crypto.randomUUID(),
					type: "file",
					name: file.name,
					mimeType: file.type,
					data: "contents",
				}),
			}),
		],
	});
	t.after(() => ui.destroy());
	assert.equal(container.querySelector("form"), form);
	const picker = form.querySelector<HTMLInputElement>('input[type="file"]')!;
	const file = new window.File(["contents"], "note.txt", { type: "text/plain" });
	Object.defineProperty(picker, "files", { value: [file, file] });
	picker.dispatchEvent(new window.Event("change"));
	await waitFor(() => !container.querySelector<HTMLButtonElement>(".mur-send-btn")!.disabled, "file ready");
	submit(form);
	await waitFor(() => Boolean(sent), "file submission");
	assert.equal(sent!.length, 1);
	assert.equal(new Set(sent![0].blocks.map((block) => block.id)).size, 2);
	assert.deepEqual(
		sent![0].blocks.map(({ id: _id, ...block }) => block),
		Array.from({ length: 2 }, () => ({ type: "file", mimeType: "text/plain", name: "note.txt", data: "contents" })),
	);
	assert.equal(container.querySelectorAll(".mur-attachment-preview-item").length, 0);
});

test("ChatUI applies embedded layout and skips page-scroll when fullscreen is false", async () => {
	const container = installDom("https://example.test/");
	const { ChatUI } = await import("./main");

	const ui = new ChatUI({
		container,
		enableSidebar: false,
		fullscreen: false,
		provider: {
			async streamChat(): Promise<void> {},
		},
		routing: false,
		storage: new MemoryStorage(),
	});

	assert.equal(document.documentElement.classList.contains("mur-chat-page-scroll"), false);
	assert.equal(container.classList.contains("mur-app-embedded"), true);

	await ui.destroy();
	assert.equal(document.documentElement.classList.contains("mur-chat-page-scroll"), false);
	assert.equal(container.classList.contains("mur-app-embedded"), false);
});

test("ChatUI ref-counts the fullscreen page-scroll class", async () => {
	const containerA = installDom();
	const containerB = document.createElement("div");
	containerB.innerHTML = renderShell();
	document.body.appendChild(containerB.firstElementChild as HTMLElement);
	const appB = document.querySelectorAll<HTMLElement>(".mur-app")[1];
	assert.ok(appB);

	const { ChatUI } = await import("./main");
	const provider: ChatProvider = {
		async streamChat(): Promise<void> {},
	};
	const uiA = new ChatUI({
		container: containerA,
		enableSidebar: false,
		provider,
		routing: false,
		storage: new MemoryStorage(),
	});
	const uiB = new ChatUI({
		container: appB,
		enableSidebar: false,
		provider,
		routing: false,
		storage: new MemoryStorage(),
	});

	assert.equal(document.documentElement.classList.contains("mur-chat-page-scroll"), true);

	await uiA.destroy();
	assert.equal(document.documentElement.classList.contains("mur-chat-page-scroll"), true);

	await uiB.destroy();
	assert.equal(document.documentElement.classList.contains("mur-chat-page-scroll"), false);
});

test("ChatUI passes titleOptions into auto-title generation", async () => {
	const container = installDom();
	const { ChatUI } = await import("./main");
	let titleOptions: RequestOptions = {};
	const provider: ChatProvider = {
		async streamChat(request: ChatStreamRequest, onChange: (changes: ConversationChange[]) => void): Promise<void> {
			onChange([
				{ type: "block.put", messageId: request.messageId, block: { id: "reply", type: "text", text: "hello back" } },
			]);
		},
		async generateTitle(request): Promise<string> {
			titleOptions = request.options;
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
			async streamChat(): Promise<void> {},
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

test("ChatUI preserves layout and focuses the input once while switching stored chats", async (t) => {
	const container = installDom();
	const { ChatUI } = await import("./main");

	const { promise: loadReleased, resolve: releaseLoad } = Promise.withResolvers<void>();
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
			async streamChat(): Promise<void> {},
		},
		routing: false,
		storage,
	});

	await waitFor(() => !ui.engine.state.isLoadingSessions, "stored history load");
	await ui.engine.sessions.switch("chat-1");

	assert.equal(container.classList.contains("mur-chat-empty"), false);
	const input = container.querySelector<HTMLTextAreaElement>(".mur-chat-input")!;
	const focus = t.mock.method(input, "focus");

	const switchPromise = ui.engine.sessions.switch("chat-2");
	await waitFor(() => delayedLoadStarted && ui.engine.state.isLoadingSession, "chat 2 load start");

	assert.deepEqual(ui.engine.state.messages, []);
	assert.equal(container.classList.contains("mur-chat-empty"), false);
	assert.equal(input.disabled, false);
	assert.equal(focus.mock.callCount(), 1);

	releaseLoad();
	await switchPromise;

	assert.equal(container.classList.contains("mur-chat-empty"), false);
	assert.equal(focus.mock.callCount(), 1);

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
		async streamChat(): Promise<void> {},
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
	assert.equal(container.classList.contains("mur-sidebar-closed"), true);

	sidebar.click();
	assert.equal(container.classList.contains("mur-sidebar-closed"), false);

	closeBtn.click();
	assert.equal(container.classList.contains("mur-sidebar-closed"), true);

	openBtn.click();
	assert.equal(container.classList.contains("mur-sidebar-closed"), false);

	storedChatLink.click();
	await waitFor(() => ui.engine.state.currentSessionId === "chat-1", "stored session selection");
	assert.equal(container.querySelector(".mur-header-title")?.textContent, "Stored Chat");

	(container.querySelector(".mur-new-chat-btn") as HTMLButtonElement).click();
	assert.notEqual(ui.engine.state.currentSessionId, previousSessionId);

	await ui.destroy();
});

test("ChatUI restores the persisted desktop sidebar state before enabling transitions", async () => {
	const container = installDom("https://example.test/", { rootClass: "mur-sidebar-animated" });
	localStorage.setItem("mur_sidebar_closed", "true");
	const sidebar = container.querySelector(".mur-sidebar") as HTMLElement;
	let restoredBeforeAnimation = false;
	const getBoundingClientRect = sidebar.getBoundingClientRect.bind(sidebar);
	sidebar.getBoundingClientRect = () => {
		restoredBeforeAnimation =
			container.classList.contains("mur-sidebar-closed") && !container.classList.contains("mur-sidebar-animated");
		return getBoundingClientRect();
	};

	const { ChatUI } = await import("./main");
	const ui = new ChatUI({
		container,
		provider: {
			async streamChat(): Promise<void> {},
		},
		routing: false,
		storage: new MemoryStorage(),
	});

	assert.equal(container.classList.contains("mur-sidebar-closed"), true);
	assert.equal(container.classList.contains("mur-sidebar-animated"), true);
	assert.equal(restoredBeforeAnimation, true);

	await ui.destroy();
});

test("ChatUI supports headers without visible titles while syncing the window title", async () => {
	const container = installDom("https://example.test/", { includeHeaderTitle: false });
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
		async streamChat(): Promise<void> {},
	};

	const ui = new ChatUI({
		container,
		provider,
		routing: false,
		storage,
		updateWindowTitle: (title) => `Murm: ${title}`,
	});

	await waitFor(() => !ui.engine.state.isLoadingSessions, "stored history load");
	assert.equal(container.querySelector(".mur-header-title"), null);
	assert.equal(document.title, "Murm: New Chat");

	(container.querySelector(".mur-sidebar-item-link") as HTMLAnchorElement).click();
	await waitFor(() => ui.engine.state.currentSessionId === "chat-1", "stored session selection");

	assert.equal(document.title, "Murm: Stored Chat");

	await ui.destroy();
});

test("ChatUI restores per-chat input drafts when switching sessions", async () => {
	const container = installDom();
	const { ChatUI } = await import("./main");
	const storage = new MemoryStorage([
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
	const provider: ChatProvider = {
		async streamChat(): Promise<void> {},
	};

	const ui = new ChatUI({
		container,
		provider,
		routing: false,
		storage,
	});

	await waitFor(() => !ui.engine.state.isLoadingSessions, "stored history load");
	await ui.engine.sessions.switch("chat-1");

	const input = container.querySelector(".mur-chat-input") as HTMLTextAreaElement;
	const form = container.querySelector(".mur-chat-form") as HTMLFormElement;

	setInputValue(input, "draft for one");
	await ui.engine.sessions.switch("chat-2");

	assert.equal(input.value, "");

	setInputValue(input, "draft for two");
	await ui.engine.sessions.switch("chat-1");

	assert.equal(input.value, "draft for one");

	await ui.engine.sessions.switch("chat-2");

	assert.equal(input.value, "draft for two");

	submit(form);
	await waitFor(() => ui.engine.state.generatingMessageId === null, "submitted draft");
	await ui.engine.sessions.switch("chat-1");
	await ui.engine.sessions.switch("chat-2");

	assert.equal(input.value, "");

	await ui.destroy();
});

test("ChatUI passes sidebarMenu config into session menus", async () => {
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
		async streamChat(): Promise<void> {},
	};
	let seenEngine: unknown;
	let seenSessionId = "";

	const ui = new ChatUI({
		container,
		provider,
		routing: false,
		storage,
		sidebarMenu: (defaults, ctx) => {
			seenEngine = ctx.engine;
			seenSessionId = ctx.session.id;
			return [...defaults, { id: "archive", label: "Archive", onClick: () => {} }];
		},
	});

	await waitFor(() => !ui.engine.state.isLoadingSessions, "stored history load");
	(container.querySelector(".mur-sidebar-options-btn") as HTMLButtonElement).click();

	assert.equal(seenEngine, ui.engine);
	assert.equal(seenSessionId, "chat-1");
	assert.deepEqual(
		Array.from(container.querySelectorAll(".mur-dropdown-item")).map((item) => item.textContent),
		["Rename", "Pin", "Delete", "Archive"],
	);

	closeDropdown();
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
		async streamChat(): Promise<void> {},
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

	const { promise: loadReleased, resolve: releaseLoad } = Promise.withResolvers<void>();

	const { promise: loadStartedPromise, resolve: loadStarted } = Promise.withResolvers<void>();

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
		async streamChat(): Promise<void> {},
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
