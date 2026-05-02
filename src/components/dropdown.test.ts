import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { closeDropdown, showDropdown } from "./dropdown";

const originalDocument = globalThis.document;

afterEach(() => {
	closeDropdown();
	setGlobal("document", originalDocument);
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

function rect(left: number, top: number, width: number, height: number): DOMRect {
	return {
		bottom: top + height,
		height,
		left,
		right: left + width,
		top,
		width,
		x: left,
		y: top,
		toJSON: () => ({}),
	};
}

function installDom() {
	const dom = new JSDOM(`
		<div class="mur-app">
			<button type="button" id="trigger">Options</button>
		</div>
	`);
	setGlobal("document", dom.window.document);

	const app = dom.window.document.querySelector<HTMLElement>(".mur-app");
	const trigger = dom.window.document.querySelector<HTMLElement>("#trigger");
	assert.ok(app);
	assert.ok(trigger);

	app.getBoundingClientRect = () => rect(0, 0, 220, 200);
	trigger.getBoundingClientRect = () => rect(180, 20, 20, 20);

	Object.defineProperties(dom.window.HTMLElement.prototype, {
		offsetHeight: {
			configurable: true,
			get() {
				return this.classList.contains("mur-dropdown-menu") ? 40 : 0;
			},
		},
		offsetWidth: {
			configurable: true,
			get() {
				return this.classList.contains("mur-dropdown-menu") ? 160 : 0;
			},
		},
	});

	return { document: dom.window.document, trigger };
}

test("aligns left and right edges according to the align option", () => {
	const { document, trigger } = installDom();

	showDropdown(trigger, [{ id: "delete", label: "Delete", onClick: () => {} }], { align: "left" });
	let menu = document.querySelector<HTMLElement>(".mur-dropdown-menu");
	assert.equal(menu?.style.left, "180px");
	assert.equal(menu?.style.right, "auto");

	closeDropdown();
	showDropdown(trigger, [{ id: "delete", label: "Delete", onClick: () => {} }], { align: "right" });
	menu = document.querySelector<HTMLElement>(".mur-dropdown-menu");
	assert.equal(menu?.style.left, "auto");
	assert.equal(menu?.style.right, "20px");
});

test("defaults to right-edge alignment when the menu would overflow the app", () => {
	const { document, trigger } = installDom();

	showDropdown(trigger, [{ id: "delete", label: "Delete", onClick: () => {} }]);

	const menu = document.querySelector<HTMLElement>(".mur-dropdown-menu");
	assert.equal(menu?.style.left, "auto");
	assert.equal(menu?.style.right, "20px");
});

test("sets menu accessibility attributes and restores focus on Escape", async () => {
	const { document, trigger } = installDom();

	showDropdown(trigger, [
		{ id: "rename", label: "Rename", disabled: true, onClick: () => {} },
		{ id: "delete", label: "Delete", onClick: () => {} },
	]);

	const menu = document.querySelector<HTMLElement>(".mur-dropdown-menu");
	assert.equal(menu?.getAttribute("role"), "menu");
	assert.equal(menu?.getAttribute("aria-orientation"), "vertical");
	assert.equal(trigger.getAttribute("aria-haspopup"), "menu");
	assert.equal(trigger.getAttribute("aria-expanded"), "true");
	assert.equal(trigger.getAttribute("aria-controls"), menu?.id);
	assert.equal(document.activeElement, menu);

	document.dispatchEvent(new document.defaultView!.KeyboardEvent("keydown", { key: "Escape" }));

	assert.equal(document.querySelector(".mur-dropdown-menu"), null);
	assert.equal(trigger.hasAttribute("aria-haspopup"), false);
	assert.equal(trigger.hasAttribute("aria-expanded"), false);
	assert.equal(trigger.hasAttribute("aria-controls"), false);
	assert.equal(document.activeElement, trigger);
});

test("moves focus through enabled menu items with arrow keys", () => {
	const { document, trigger } = installDom();

	showDropdown(trigger, [
		{ id: "rename", label: "Rename", onClick: () => {} },
		{ id: "delete", label: "Delete", onClick: () => {} },
	]);

	assert.equal(document.activeElement?.getAttribute("role"), "menu");
	document.activeElement?.dispatchEvent(
		new document.defaultView!.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
	);
	assert.equal(document.activeElement?.textContent, "Rename");
	document.activeElement?.dispatchEvent(
		new document.defaultView!.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
	);
	assert.equal(document.activeElement?.textContent, "Delete");
	document.activeElement?.dispatchEvent(
		new document.defaultView!.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
	);
	assert.equal(document.activeElement?.textContent, "Rename");
});

test("closes when pressing outside the menu and trigger", () => {
	const { document, trigger } = installDom();
	const outside = document.createElement("button");
	document.body.appendChild(outside);

	showDropdown(trigger, [{ id: "delete", label: "Delete", onClick: () => {} }]);
	outside.dispatchEvent(new document.defaultView!.PointerEvent("pointerdown", { bubbles: true }));

	assert.equal(document.querySelector(".mur-dropdown-menu"), null);
});
