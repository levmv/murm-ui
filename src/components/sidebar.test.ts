import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import type { ChatEngine } from "../core/chat-engine";
import { closeDropdown } from "./dropdown";
import { Sidebar, type SidebarMenuBuilder } from "./sidebar";

const originalDocument = globalThis.document;
const originalIntersectionObserver = globalThis.IntersectionObserver;

afterEach(() => {
	closeDropdown();
	setGlobal("document", originalDocument);
	setGlobal("IntersectionObserver", originalIntersectionObserver);
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

function createEngine(deleteSession: (id: string) => void = () => {}): ChatEngine {
	return {
		sessions: {
			delete: async (id: string) => {
				deleteSession(id);
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

	sidebar.renderSessions([{ id: "chat-1", title: "Stored Chat", updatedAt: 1 }], "chat-1", false);

	const optionsBtn = container.querySelector<HTMLButtonElement>(".mur-sidebar-options-btn");
	assert.ok(optionsBtn);
	optionsBtn.click();

	const menuItems = Array.from(container.querySelectorAll<HTMLButtonElement>(".mur-dropdown-item"));
	assert.deepEqual(
		menuItems.map((item) => item.textContent),
		["Rename", "Delete"],
	);

	menuItems[1].click();
	assert.deepEqual(deletedIds, ["chat-1"]);

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

	assert.deepEqual(seen[0], ["rename", "delete"]);
	assert.deepEqual(seen[1], { type: "session", session, engine });

	const menuItems = Array.from(container.querySelectorAll<HTMLButtonElement>(".mur-dropdown-item"));
	assert.deepEqual(
		menuItems.map((item) => item.textContent),
		["Rename", "Delete", "Archive"],
	);
	menuItems[2].click();
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
		["Rename", "Delete"],
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
