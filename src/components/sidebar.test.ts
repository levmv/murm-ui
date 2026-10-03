import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { ChatEngine } from "../core/chat-engine";
import { closeDropdown, showDropdown } from "./dropdown";
import { Sidebar, type SidebarSession } from "./sidebar";

const originalDocument = globalThis.document;
const originalObserver = globalThis.IntersectionObserver;
const originalConfirm = globalThis.confirm;
const mounted: Sidebar[] = [];

afterEach(() => {
	for (const sidebar of mounted) sidebar.destroy();
	mounted.length = 0;
	closeDropdown();
	setGlobal("document", originalDocument);
	setGlobal("IntersectionObserver", originalObserver);
	setGlobal("confirm", originalConfirm);
});

function setGlobal(name: string, value: unknown): void {
	Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}

function installDom() {
	const dom = new JSDOM('<div class="mur-app"><main><button class="mur-open-sidebar-btn">Open</button></main></div>', {
		url: "https://example.test/",
		pretendToBeVisual: true,
	});
	setGlobal("document", dom.window.document);
	setGlobal("IntersectionObserver", undefined);
	Object.defineProperty(dom.window, "matchMedia", {
		value: () => ({
			addEventListener() {},
			removeEventListener() {},
			get matches() {
				return dom.window.innerWidth <= 768;
			},
		}),
	});
	return document.querySelector<HTMLElement>(".mur-app")!;
}

function mount(config: ConstructorParameters<typeof Sidebar>[0]) {
	const sidebar = new Sidebar(config);
	mounted.push(sidebar);
	return sidebar;
}

function clickMenu(id: string, label: string): void {
	const row = Array.from(document.querySelectorAll<HTMLElement>(".mur-sidebar-item")).find(
		(row) => row.dataset.sessionId === id,
	)!;
	row.querySelector<HTMLButtonElement>(".mur-sidebar-options-btn")!.click();
	const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".mur-dropdown-item")).find(
		(button) => button.textContent === label,
	);
	assert.ok(button, `Missing menu item: ${label}`);
	button.click();
}

function key(input: HTMLElement, key: string, isComposing = false): void {
	input.dispatchEvent(
		new document.defaultView!.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, isComposing }),
	);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("creates a complete panel with app content, links and responsive controls", () => {
	const container = installDom();
	const logo = document.createElement("strong");
	logo.textContent = "Agent Lab";
	const footer = document.createElement("button");
	footer.textContent = "Account";
	let created = 0;
	let settings = 0;
	const collapsed: boolean[] = [];
	const sidebar = mount({
		container,
		header: logo,
		footer,
		links: [
			{ label: "Files", href: "/files" },
			{
				label: "Settings",
				onClick: () => {
					settings++;
				},
			},
		],
		onNew: () => {
			created++;
		},
		onCollapse: (value) => {
			collapsed.push(value);
		},
	});
	assert.equal(container.firstElementChild, sidebar.element);
	assert.equal(container.querySelector(".mur-sidebar-logo")?.firstChild, logo);
	assert.equal(container.querySelector(".mur-sidebar-footer")?.firstChild, footer);
	const links = container.querySelectorAll<HTMLElement>(".mur-sidebar-nav-btn");
	assert.equal(links.length, 3);
	assert.ok(links[0].querySelector("svg"));
	assert.equal(links[1].getAttribute("href"), "/files");
	links[0].click();
	links[2].click();
	assert.equal(created, 1);
	assert.equal(settings, 1);
	container.querySelector<HTMLButtonElement>(".mur-close-sidebar-btn")!.click();
	assert.equal(container.classList.contains("mur-sidebar-closed"), true);
	sidebar.element.click();
	assert.deepEqual(collapsed, [true, false]);
	Object.defineProperty(document.defaultView!, "innerWidth", { value: 390, configurable: true });
	container.querySelector<HTMLButtonElement>(".mur-open-sidebar-btn")!.click();
	assert.equal(sidebar.element.classList.contains("mur-mobile-open"), true);
	key(sidebar.element, "Escape");
	assert.equal(sidebar.element.classList.contains("mur-mobile-open"), false);
	sidebar.open();
	links[2].click();
	assert.equal(sidebar.element.classList.contains("mur-mobile-open"), false);
	sidebar.open();
	container.querySelector("main")!.click();
	assert.equal(sidebar.element.classList.contains("mur-mobile-open"), false);
	assert.deepEqual(collapsed, [true, false]);
	sidebar.destroy();
	assert.equal(container.querySelector(".mur-sidebar"), null);
	links[0].click();
	links[2].click();
	assert.equal(created, 1);
	assert.equal(settings, 2);
});

test("keeps row and open menu identity on polling, with no DOM writes for unchanged data", () => {
	const container = installDom();
	const selected: string[] = [];
	const sidebar = mount({
		container,
		onSelect: (id) => {
			selected.push(id);
		},
		onRename: () => {},
		getHref: (id) => `#/chat/${encodeURIComponent(id)}`,
	});
	const id = 'chat"[]/one';
	const sessions = [
		{ id, title: "One" },
		{ id: "two", title: "Two" },
	];
	sidebar.update({ sessions, activeId: id });
	const row = container.querySelector<HTMLElement>(".mur-sidebar-item")!;
	const link = row.querySelector<HTMLAnchorElement>("a")!;
	const modified = new document.defaultView!.MouseEvent("click", { ctrlKey: true, cancelable: true, bubbles: true });
	link.dispatchEvent(modified);
	assert.equal(modified.defaultPrevented, false);
	link.click();
	assert.deepEqual(selected, [id]);
	assert.equal(link.getAttribute("aria-current"), "page");
	row.querySelector<HTMLButtonElement>("button")!.click();
	const menu = container.querySelector(".mur-dropdown-menu");
	const button = menu!.querySelector<HTMLButtonElement>("button")!;
	button.focus();
	const observer = new document.defaultView!.MutationObserver(() => {});
	observer.observe(container, { attributes: true, childList: true, characterData: true, subtree: true });
	for (let i = 0; i < 10; i++) sidebar.update({ sessions: sessions.map((session) => ({ ...session })), activeId: id });
	assert.equal(observer.takeRecords().length, 0);
	observer.disconnect();
	sidebar.update({ sessions: [sessions[1], { id, title: "Updated" }], activeId: "two" });
	assert.equal(container.querySelectorAll(".mur-sidebar-item")[1], row);
	assert.equal(row.querySelector("a"), link);
	assert.equal(link.textContent, "Updated");
	assert.equal(link.hasAttribute("aria-current"), false);
	assert.equal(container.querySelector(".mur-dropdown-menu"), menu);
	assert.equal(document.activeElement, button);
	sidebar.update({ sessions: [sessions[1]] });
	assert.equal(container.querySelector(".mur-dropdown-menu"), null);
});

test("preserves a rename draft and selection through reordering and remote title changes", () => {
	const container = installDom();
	const renamed: string[] = [];
	const sidebar = mount({
		container,
		onRename: (_id, title) => {
			renamed.push(title);
		},
	});
	const sessions = [
		{ id: "a", title: "Original" },
		{ id: "b", title: "Second" },
	];
	sidebar.update({ sessions });
	clickMenu("a", "Rename");
	const input = container.querySelector<HTMLInputElement>("input")!;
	input.value = "My draft";
	input.setSelectionRange(2, 5);
	sidebar.update({ sessions: [sessions[1], { id: "a", title: "Remote" }] });
	assert.equal(container.querySelector("input"), input);
	assert.equal(document.activeElement, input);
	assert.equal(input.value, "My draft");
	assert.equal(input.selectionStart, 2);
	assert.equal(input.selectionEnd, 5);
	key(input, "Escape");
	assert.deepEqual(renamed, []);
	assert.equal(container.querySelectorAll(".mur-sidebar-item-title")[1].textContent, "Remote");
	clickMenu("a", "Rename");
	const next = container.querySelector<HTMLInputElement>("input")!;
	next.value = " Saved ";
	key(next, "Enter", true);
	assert.equal(container.querySelector("input"), next);
	key(next, "Enter");
	next.dispatchEvent(new document.defaultView!.Event("blur"));
	assert.deepEqual(renamed, ["Saved"]);
	assert.equal(container.querySelectorAll(".mur-sidebar-item-title")[1].textContent, "Saved");
});

test("failed or late rename acknowledgement cannot overwrite newer server data or a reused ID", async () => {
	const container = installDom();
	let save = Promise.withResolvers<void>();
	const sidebar = mount({ container, onRename: () => save.promise });
	sidebar.update({ sessions: [{ id: "a", title: "Original" }] });
	clickMenu("a", "Rename");
	const input = container.querySelector<HTMLInputElement>("input")!;
	input.value = "Pending";
	input.dispatchEvent(new document.defaultView!.Event("blur"));
	assert.equal(container.querySelector(".mur-sidebar-item-title")?.textContent, "Pending");
	sidebar.update({ sessions: [{ id: "a", title: "Original" }] });
	assert.equal(container.querySelector(".mur-sidebar-item-title")?.textContent, "Pending");
	save.reject(new Error("Save failed"));
	await tick();
	assert.equal(container.querySelector(".mur-sidebar-item-title")?.textContent, "Original");
	assert.equal(container.querySelector('[role="alert"]')?.textContent, "Save failed");
	save = Promise.withResolvers<void>();
	clickMenu("a", "Rename");
	const next = container.querySelector<HTMLInputElement>("input")!;
	next.value = "Pending again";
	key(next, "Enter");
	sidebar.update({ sessions: [{ id: "a", title: "Newer server title" }] });
	save.resolve();
	await tick();
	assert.equal(container.querySelector(".mur-sidebar-item-title")?.textContent, "Newer server title");
	assert.equal(container.querySelector('[role="alert"]'), null);

	save = Promise.withResolvers<void>();
	clickMenu("a", "Rename");
	const last = container.querySelector<HTMLInputElement>("input")!;
	last.value = "Too late";
	key(last, "Enter");
	sidebar.update({ sessions: [] });
	sidebar.update({ sessions: [{ id: "a", title: "Replacement" }] });
	save.reject(new Error("Old error"));
	await tick();
	assert.equal(container.querySelector(".mur-sidebar-item-title")?.textContent, "Replacement");
	assert.equal(container.querySelector('[role="alert"]'), null);
});

test("reconciles menu actions from current app data and removes the trigger when none remain", () => {
	const container = installDom();
	interface Session extends SidebarSession {
		editable: boolean;
	}
	const actions: string[] = [];
	const sidebar = new Sidebar<Session>({
		container,
		onRename: () => {},
		menu: (defaults, session) =>
			session.editable
				? [
						...defaults,
						{
							id: "custom",
							label: session.title,
							onClick: () => {
								actions.push(session.title);
							},
						},
					]
				: [],
	});
	const update = (title: string, editable = true) => sidebar.update({ sessions: [{ id: "a", title, editable }] });
	update("Before");
	container.querySelector<HTMLButtonElement>(".mur-sidebar-options-btn")!.click();
	const button = container.querySelectorAll<HTMLButtonElement>(".mur-dropdown-item")[1];
	button.focus();
	update("After");
	assert.equal(container.querySelectorAll(".mur-dropdown-item")[1], button);
	assert.equal(document.activeElement, button);
	assert.equal(button.textContent, "After");
	button.click();
	assert.deepEqual(actions, ["After"]);
	container.querySelector<HTMLButtonElement>(".mur-sidebar-options-btn")!.click();
	update("After", false);
	assert.equal(container.querySelector(".mur-sidebar-options-btn"), null);
	assert.equal(container.querySelector(".mur-dropdown-menu"), null);
	sidebar.destroy();
});

test("pin policy and asynchronous delete confirmation stay in callbacks", async () => {
	const container = installDom();
	const pinned: [string, boolean][] = [];
	const deleted: string[] = [];
	let confirmation = Promise.withResolvers<boolean>();
	const sidebar = mount({
		container,
		pinLimit: 1,
		onPin: (id, pin) => {
			pinned.push([id, pin]);
		},
		onDelete: (id) => {
			deleted.push(id);
		},
		confirmDelete: () => confirmation.promise,
	});
	const sessions = [
		{ id: "a", title: "Pinned", isPinned: true },
		{ id: "b", title: "Other" },
	];
	sidebar.update({ sessions });
	assert.equal(container.querySelectorAll(".mur-sidebar-pin-icon").length, 1);
	assert.equal(container.querySelectorAll(".mur-sidebar-pin-divider").length, 1);
	clickMenu("a", "Unpin");
	assert.deepEqual(pinned, [["a", false]]);
	clickMenu("b", "Pin");
	assert.equal(container.querySelector<HTMLButtonElement>(".mur-dropdown-item")!.disabled, true);
	closeDropdown();
	clickMenu("b", "Delete");
	confirmation.resolve(false);
	await tick();
	assert.deepEqual(deleted, []);
	confirmation = Promise.withResolvers<boolean>();
	clickMenu("b", "Delete");
	confirmation.resolve(true);
	await tick();
	assert.deepEqual(deleted, ["b"]);
	confirmation = Promise.withResolvers<boolean>();
	clickMenu("a", "Delete");
	sidebar.update({ sessions: [] });
	confirmation.resolve(true);
	await tick();
	assert.deepEqual(deleted, ["b"]);
});

test("manual pagination works without an observer and suppresses duplicate requests", async () => {
	const container = installDom();
	const page = Promise.withResolvers<void>();
	let loads = 0;
	const sidebar = mount({
		container,
		onLoadMore: () => {
			loads++;
			return page.promise;
		},
	});
	sidebar.update({ sessions: [], hasMore: true, loading: true });
	assert.match(container.textContent!, /Loading chats/);
	sidebar.update({ sessions: [{ id: "a", title: "First" }], hasMore: true });
	const button = container.querySelector<HTMLButtonElement>(".mur-sidebar-load-more-trigger")!;
	button.click();
	button.click();
	assert.equal(loads, 1);
	assert.equal(button.disabled, true);
	sidebar.update({
		sessions: [
			{ id: "a", title: "First" },
			{ id: "b", title: "Second" },
		],
		hasMore: false,
	});
	page.resolve();
	await tick();
	assert.equal(container.querySelector(".mur-sidebar-load-more-trigger"), null);
});

test("failed engine pagination waits for a manual retry and cleans up the observer", async (t) => {
	t.mock.method(console, "error", () => {});
	const container = installDom();
	let intersect!: () => void;
	let observed = false;
	let disconnected = false;
	setGlobal(
		"IntersectionObserver",
		class {
			constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
				intersect = () => callback([{ isIntersecting: true }]);
			}
			observe() {
				observed = true;
			}
			unobserve() {
				observed = false;
			}
			disconnect() {
				disconnected = true;
			}
		},
	);
	let loads = 0;
	const engine = new ChatEngine({
		provider: { async streamChat() {} },
		storage: {
			async loadSessions(_limit, cursor) {
				if (!cursor) return { items: [{ id: "a", title: "One", updatedAt: 2 }], hasMore: true };
				loads++;
				if (loads === 1) throw new Error("Offline");
				return { items: [{ id: "b", title: "Two", updatedAt: 1 }], hasMore: true };
			},
			async loadOne() {
				return null;
			},
			async save() {},
			async delete() {},
		},
	});
	t.after(() => engine.destroy());
	const sidebar = mount({
		container,
		onLoadMore: () => engine.sessions.loadMore(),
	});
	engine.subscribe(
		(state) => state,
		(state) =>
			sidebar.update({ sessions: state.sessions, hasMore: state.hasMoreSessions, loading: state.isLoadingSessions }),
	);
	await engine.sessions.loadHistory();
	assert.equal(observed, true);
	intersect();
	await tick();
	assert.equal(observed, false);
	assert.equal(container.querySelector('[role="alert"]')?.textContent, "Offline");
	container.querySelector<HTMLButtonElement>(".mur-sidebar-load-more-trigger")!.click();
	await tick();
	assert.equal(loads, 2);
	assert.equal(observed, true);
	assert.deepEqual(
		engine.state.sessions.map((session) => session.id),
		["a", "b"],
	);
	sidebar.destroy();
	intersect();
	assert.equal(loads, 2);
	assert.equal(disconnected, true);
});

test("destroying a sidebar leaves another component's dropdown alone", () => {
	const container = installDom();
	const sidebar = mount({ container, onRename: () => {} });
	sidebar.update({ sessions: [{ id: "a", title: "One" }] });
	showDropdown(container.querySelector<HTMLElement>("main button")!, [
		{ id: "settings", label: "Settings", onClick: () => {} },
	]);
	sidebar.destroy();
	assert.equal(container.querySelector(".mur-dropdown-item")?.textContent, "Settings");
});
