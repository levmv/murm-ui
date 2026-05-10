import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import type { ChatEngine } from "../core/chat-engine";
import { closeDropdown } from "./dropdown";
import { Sidebar, type SidebarMenuBuilder } from "./sidebar";

const originalDocument = globalThis.document;
const originalIntersectionObserver = globalThis.IntersectionObserver;
const originalConfirm = globalThis.confirm;

afterEach(() => {
	closeDropdown();
	setGlobal("document", originalDocument);
	setGlobal("IntersectionObserver", originalIntersectionObserver);
	setGlobal("confirm", originalConfirm);
});

function setGlobal(name: string, value: unknown): void {
	if (value === undefined) {
		Reflect.deleteProperty(globalThis, name);
		return;
	}

	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
		writable: true,
	});
}

function installDom(): HTMLElement {
	const dom = new JSDOM(`
		<div class="mur-app">
			<aside class="mur-sidebar">
				<button type="button" class="mur-close-sidebar-btn">Close</button>
				<button type="button" class="mur-new-chat-btn">New</button>
				<div class="mur-sidebar-content"></div>
			</aside>
		</div>
	`);

	setGlobal("document", dom.window.document);

	return dom.window.document.querySelector(".mur-app") as HTMLElement;
}

function createEngine(
	deleteSession: (id: string) => void = () => {},
	updateTitle: (id: string, title: string) => void | Promise<void> = () => {},
	updatePinned: (id: string, isPinned: boolean) => void = () => {},
): ChatEngine {
	return {
		sessions: {
			delete: async (id: string) => {
				deleteSession(id);
			},
			updateTitle: async (id: string, title: string) => {
				await updateTitle(id, title);
			},
			updatePinned: async (id: string, isPinned: boolean) => {
				updatePinned(id, isPinned);
			},
		},
	} as unknown as ChatEngine;
}

function createSidebar(
	container: HTMLElement,
	options: {
		engine?: ChatEngine;
		sidebarMenu?: SidebarMenuBuilder;
	} = {},
): Sidebar {
	return new Sidebar({
		container,
		engine: options.engine ?? createEngine(),
		onNewChat: () => {},
		onSelectSession: () => {},
		onLoadMore: () => {},
		onClose: () => {},
		getSessionHref: (id) => `#/chat/${encodeURIComponent(id)}`,
		sidebarMenu: options.sidebarMenu,
	});
}

test("renders without IntersectionObserver and skips sidebar pagination", () => {
	const container = installDom();
	let loadMoreCalls = 0;
	setGlobal("IntersectionObserver", undefined);

	const sidebar = new Sidebar({
		container,
		engine: createEngine(),
		onNewChat: () => {},
		onSelectSession: () => {},
		onLoadMore: () => {
			loadMoreCalls++;
		},
		onClose: () => {},
		getSessionHref: (id) => `#/chat/${id}`,
	});

	assert.doesNotThrow(() => {
		sidebar.renderSessions([{ id: "chat-1", title: "Stored Chat", updatedAt: 1 }], "chat-1", true);
		sidebar.destroy();
	});
	assert.equal(loadMoreCalls, 0);
});

test("setActiveSession matches custom ids without building a selector from the id", () => {
	const container = installDom();
	const selectorHostileId = 'chat"] [data-session-id="other';
	setGlobal("IntersectionObserver", undefined);
	const sidebar = new Sidebar({
		container,
		engine: createEngine(),
		onNewChat: () => {},
		onSelectSession: () => {},
		onLoadMore: () => {},
		onClose: () => {},
		getSessionHref: (id) => `#/chat/${encodeURIComponent(id)}`,
	});

	sidebar.renderSessions(
		[
			{ id: "chat-1", title: "First", updatedAt: 2 },
			{ id: selectorHostileId, title: "Second", updatedAt: 1 },
		],
		"chat-1",
		false,
	);
	sidebar.setActiveSession(selectorHostileId);

	const active = container.querySelector(".mur-sidebar-item.mur-active");
	assert.equal(active?.getAttribute("data-session-id"), selectorHostileId);
	assert.equal(active?.querySelector(".mur-sidebar-item-link")?.getAttribute("aria-current"), "page");

	sidebar.destroy();
});

test("renders the built-in session menu and deletes through the engine", () => {
	const container = installDom();
	const deletedIds: string[] = [];
	const sidebar = createSidebar(container, { engine: createEngine((id) => deletedIds.push(id)) });
	setGlobal("confirm", () => true);

	sidebar.renderSessions([{ id: "chat-1", title: "Stored Chat", updatedAt: 1 }], "chat-1", false);

	const optionsBtn = container.querySelector<HTMLButtonElement>(".mur-sidebar-options-btn");
	assert.ok(optionsBtn);
	optionsBtn.click();

	const menuItems = Array.from(container.querySelectorAll<HTMLButtonElement>(".mur-dropdown-item"));
	assert.deepEqual(
		menuItems.map((item) => item.textContent),
		["Rename", "Pin", "Delete"],
	);

	menuItems[2].click();
	assert.deepEqual(deletedIds, ["chat-1"]);

	sidebar.destroy();
});

test("built-in delete asks for confirmation before deleting", () => {
	const container = installDom();
	const deletedIds: string[] = [];
	const prompts: string[] = [];
	const sidebar = createSidebar(container, { engine: createEngine((id) => deletedIds.push(id)) });
	setGlobal("confirm", (message: string) => {
		prompts.push(message);
		return false;
	});

	sidebar.renderSessions([{ id: "chat-1", title: "Stored Chat", updatedAt: 1 }], "chat-1", false);
	container.querySelector<HTMLButtonElement>(".mur-sidebar-options-btn")?.click();
	container.querySelectorAll<HTMLButtonElement>(".mur-dropdown-item")[2]?.click();

	assert.deepEqual(prompts, ['Delete chat "Stored Chat"? This cannot be undone.']);
	assert.deepEqual(deletedIds, []);

	sidebar.destroy();
});

test("closes an open session dropdown on rerender and destroy", () => {
	const container = installDom();
	const sidebar = createSidebar(container);

	sidebar.renderSessions([{ id: "chat-1", title: "Stored Chat", updatedAt: 1 }], "chat-1", false);
	container.querySelector<HTMLButtonElement>(".mur-sidebar-options-btn")?.click();
	assert.ok(document.querySelector(".mur-dropdown-menu"));

	sidebar.renderSessions([{ id: "chat-2", title: "Next Chat", updatedAt: 2 }], "chat-2", false);
	assert.equal(document.querySelector(".mur-dropdown-menu"), null);

	container.querySelector<HTMLButtonElement>(".mur-sidebar-options-btn")?.click();
	assert.ok(document.querySelector(".mur-dropdown-menu"));

	sidebar.destroy();
	assert.equal(document.querySelector(".mur-dropdown-menu"), null);
});

test("built-in pin menu toggles pinned state and enforces the pin limit", () => {
	const container = installDom();
	const pinnedUpdates: { id: string; isPinned: boolean }[] = [];
	const sidebar = createSidebar(container, {
		engine: createEngine(
			() => {},
			() => {},
			(id, isPinned) => pinnedUpdates.push({ id, isPinned }),
		),
	});

	sidebar.renderSessions(
		[
			{ id: "pin-1", title: "Pinned", updatedAt: 4, isPinned: true },
			{ id: "pin-2", title: "Pinned 2", updatedAt: 3, isPinned: true },
			{ id: "pin-3", title: "Pinned 3", updatedAt: 2, isPinned: true },
			{ id: "chat-1", title: "Stored Chat", updatedAt: 1 },
		],
		"chat-1",
		false,
	);

	container.querySelector<HTMLButtonElement>('[data-session-id="pin-1"] .mur-sidebar-options-btn')?.click();
	let menuItems = Array.from(container.querySelectorAll<HTMLButtonElement>(".mur-dropdown-item"));
	assert.equal(menuItems[1].textContent, "Unpin");
	menuItems[1].click();
	assert.deepEqual(pinnedUpdates, [{ id: "pin-1", isPinned: false }]);

	container.querySelector<HTMLButtonElement>('[data-session-id="chat-1"] .mur-sidebar-options-btn')?.click();
	menuItems = Array.from(container.querySelectorAll<HTMLButtonElement>(".mur-dropdown-item"));
	assert.equal(menuItems[1].textContent, "Pin");
	assert.equal(menuItems[1].disabled, true);

	sidebar.destroy();
});

test("renders pinned sessions with icon and divider", () => {
	const container = installDom();
	const sidebar = createSidebar(container);

	sidebar.renderSessions(
		[
			{ id: "pin-1", title: "Pinned", updatedAt: 2, isPinned: true },
			{ id: "chat-1", title: "Regular", updatedAt: 1 },
		],
		"pin-1",
		false,
	);

	assert.equal(container.querySelectorAll(".mur-sidebar-pin-icon").length, 1);
	assert.equal(container.querySelectorAll(".mur-sidebar-pin-divider").length, 1);

	sidebar.destroy();
});

test("rename edits in place and saves on Enter", () => {
	const container = installDom();
	const updates: { id: string; title: string }[] = [];
	const sidebar = createSidebar(container, {
		engine: createEngine(
			() => {},
			(id, title) => {
				updates.push({ id, title });
			},
		),
	});
	const session = { id: "chat-1", title: "Stored Chat", updatedAt: 1 };

	sidebar.renderSessions([session], "chat-1", false);
	container.querySelector<HTMLButtonElement>(".mur-sidebar-options-btn")?.click();
	container.querySelectorAll<HTMLButtonElement>(".mur-dropdown-item")[0]?.click();

	const input = container.querySelector<HTMLInputElement>(".mur-sidebar-rename-input");
	assert.ok(input);
	assert.ok(container.querySelector(".mur-sidebar-item")?.classList.contains("mur-renaming"));
	input.value = "  Renamed Chat  ";
	input.dispatchEvent(new input.ownerDocument.defaultView!.KeyboardEvent("keydown", { key: "Enter" }));

	assert.deepEqual(updates, [{ id: "chat-1", title: "Renamed Chat" }]);
	assert.equal(container.querySelector(".mur-sidebar-item-title")?.textContent, "Renamed Chat");
	assert.equal(container.querySelector(".mur-sidebar-item")?.classList.contains("mur-renaming"), false);

	sidebar.destroy();
});

test("rename saves on blur, cancels on Escape, and skips empty names", () => {
	const container = installDom();
	const updates: { id: string; title: string }[] = [];
	const sidebar = createSidebar(container, {
		engine: createEngine(
			() => {},
			(id, title) => {
				updates.push({ id, title });
			},
		),
	});
	const session = { id: "chat-1", title: "Stored Chat", updatedAt: 1 };

	sidebar.renderSessions([session], "chat-1", false);
	container.querySelector<HTMLButtonElement>(".mur-sidebar-options-btn")?.click();
	container.querySelectorAll<HTMLButtonElement>(".mur-dropdown-item")[0]?.click();
	let input = container.querySelector<HTMLInputElement>(".mur-sidebar-rename-input");
	assert.ok(input);
	input.value = "Blurred Chat";
	input.dispatchEvent(new input.ownerDocument.defaultView!.FocusEvent("blur"));
	assert.deepEqual(updates, [{ id: "chat-1", title: "Blurred Chat" }]);

	sidebar.renderSessions([session], "chat-1", false);
	container.querySelector<HTMLButtonElement>(".mur-sidebar-options-btn")?.click();
	container.querySelectorAll<HTMLButtonElement>(".mur-dropdown-item")[0]?.click();
	input = container.querySelector<HTMLInputElement>(".mur-sidebar-rename-input");
	assert.ok(input);
	input.value = "Canceled Chat";
	input.dispatchEvent(new input.ownerDocument.defaultView!.KeyboardEvent("keydown", { key: "Escape" }));

	sidebar.renderSessions([session], "chat-1", false);
	container.querySelector<HTMLButtonElement>(".mur-sidebar-options-btn")?.click();
	container.querySelectorAll<HTMLButtonElement>(".mur-dropdown-item")[0]?.click();
	input = container.querySelector<HTMLInputElement>(".mur-sidebar-rename-input");
	assert.ok(input);
	input.value = " ";
	input.dispatchEvent(new input.ownerDocument.defaultView!.FocusEvent("blur"));

	assert.deepEqual(updates, [{ id: "chat-1", title: "Blurred Chat" }]);
	assert.equal(container.querySelector(".mur-sidebar-item-title")?.textContent, "Stored Chat");

	sidebar.destroy();
});

test("rename rolls back optimistic title when saving fails", async () => {
	const container = installDom();
	const sidebar = createSidebar(container, {
		engine: createEngine(
			() => {},
			async () => {
				throw new Error("rename failed");
			},
		),
	});
	const session = { id: "chat-1", title: "Stored Chat", updatedAt: 1 };

	sidebar.renderSessions([session], "chat-1", false);
	container.querySelector<HTMLButtonElement>(".mur-sidebar-options-btn")?.click();
	container.querySelectorAll<HTMLButtonElement>(".mur-dropdown-item")[0]?.click();

	const input = container.querySelector<HTMLInputElement>(".mur-sidebar-rename-input");
	assert.ok(input);
	input.value = "Unsaved Chat";
	input.dispatchEvent(new input.ownerDocument.defaultView!.KeyboardEvent("keydown", { key: "Enter" }));

	assert.equal(container.querySelector(".mur-sidebar-item-title")?.textContent, "Unsaved Chat");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(container.querySelector(".mur-sidebar-item-title")?.textContent, "Stored Chat");

	sidebar.destroy();
});

test("custom sidebarMenu can append an item and receives session context with engine", () => {
	const container = installDom();
	const engine = createEngine();
	const seen: unknown[] = [];
	let customCalls = 0;
	const sidebar = createSidebar(container, {
		engine,
		sidebarMenu: (defaults, ctx) => {
			seen.push(
				defaults.map((item) => item.id),
				ctx,
			);
			return [
				...defaults,
				{
					id: "archive",
					label: "Archive",
					onClick: () => {
						customCalls++;
					},
				},
			];
		},
	});
	const session = { id: "chat-1", title: "Stored Chat", updatedAt: 1 };

	sidebar.renderSessions([session], "chat-1", false);
	container.querySelector<HTMLButtonElement>(".mur-sidebar-options-btn")?.click();

	assert.deepEqual(seen[0], ["rename", "pin", "delete"]);
	assert.deepEqual(seen[1], { type: "session", session, engine });

	const menuItems = Array.from(container.querySelectorAll<HTMLButtonElement>(".mur-dropdown-item"));
	assert.deepEqual(
		menuItems.map((item) => item.textContent),
		["Rename", "Pin", "Delete", "Archive"],
	);
	menuItems[3].click();
	assert.equal(customCalls, 1);

	sidebar.destroy();
});

test("custom sidebarMenu can replace defaults", () => {
	const container = installDom();
	const sidebar = createSidebar(container, {
		sidebarMenu: () => [{ id: "pin", label: "Pin", onClick: () => {} }],
	});

	sidebar.renderSessions([{ id: "chat-1", title: "Stored Chat", updatedAt: 1 }], "chat-1", false);
	container.querySelector<HTMLButtonElement>(".mur-sidebar-options-btn")?.click();

	const menuItems = Array.from(container.querySelectorAll<HTMLButtonElement>(".mur-dropdown-item"));
	assert.deepEqual(
		menuItems.map((item) => item.textContent),
		["Pin"],
	);

	sidebar.destroy();
});

test("custom sidebarMenu can return defaults unchanged", () => {
	const container = installDom();
	const sidebar = createSidebar(container, {
		sidebarMenu: (defaults) => defaults,
	});

	sidebar.renderSessions([{ id: "chat-1", title: "Stored Chat", updatedAt: 1 }], "chat-1", false);
	container.querySelector<HTMLButtonElement>(".mur-sidebar-options-btn")?.click();

	const menuItems = Array.from(container.querySelectorAll<HTMLButtonElement>(".mur-dropdown-item"));
	assert.deepEqual(
		menuItems.map((item) => item.textContent),
		["Rename", "Pin", "Delete"],
	);

	sidebar.destroy();
});

test("rebuilds custom menu items when opening the dropdown", () => {
	const container = installDom();
	let builderCalls = 0;
	const sidebar = createSidebar(container, {
		sidebarMenu: () => {
			builderCalls++;
			return [
				{
					id: "dynamic",
					label: builderCalls === 1 ? "Initial" : "Current",
					onClick: () => {},
				},
			];
		},
	});

	sidebar.renderSessions([{ id: "chat-1", title: "Stored Chat", updatedAt: 1 }], "chat-1", false);
	container.querySelector<HTMLButtonElement>(".mur-sidebar-options-btn")?.click();

	const menuItems = Array.from(container.querySelectorAll<HTMLButtonElement>(".mur-dropdown-item"));
	assert.equal(builderCalls, 2);
	assert.deepEqual(
		menuItems.map((item) => item.textContent),
		["Current"],
	);

	sidebar.destroy();
});

test("hides the session options button when sidebarMenu returns no items", () => {
	const container = installDom();
	const sidebar = createSidebar(container, {
		sidebarMenu: () => [],
	});

	sidebar.renderSessions([{ id: "chat-1", title: "Stored Chat", updatedAt: 1 }], "chat-1", false);

	assert.equal(container.querySelector(".mur-sidebar-options-btn"), null);
	assert.equal(container.querySelector(".mur-sidebar-item-link")?.textContent, "Stored Chat");

	sidebar.destroy();
});
