import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { Sidebar } from "./sidebar";

const originalDocument = globalThis.document;
const originalIntersectionObserver = globalThis.IntersectionObserver;

afterEach(() => {
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

test("renders without IntersectionObserver and skips sidebar pagination", () => {
	const container = installDom();
	let loadMoreCalls = 0;
	setGlobal("IntersectionObserver", undefined);

	const sidebar = new Sidebar({
		container,
		onNewChat: () => {},
		onSelectSession: () => {},
		onDeleteSession: () => {},
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
		onNewChat: () => {},
		onSelectSession: () => {},
		onDeleteSession: () => {},
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
