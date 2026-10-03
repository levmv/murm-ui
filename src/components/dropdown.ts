import { el } from "../utils/dom";

export interface DropdownItem {
	id: string;
	label: string;
	iconHtml?: string;
	danger?: boolean;
	disabled?: boolean;
	onClick: () => void;
}

export interface DropdownOptions {
	align?: "left" | "right";
	width?: string;
}

let activeDropdown: {
	menu: HTMLElement;
	trigger: HTMLElement;
	update: (items: readonly DropdownItem[]) => void;
	cleanup: (restoreFocus?: boolean) => void;
} | null = null;
let nextDropdownId = 0;

export function showDropdown(trigger: HTMLElement, items: readonly DropdownItem[], options: DropdownOptions = {}) {
	if (activeDropdown) {
		const wasSameTrigger = activeDropdown.trigger === trigger;
		activeDropdown.cleanup(wasSameTrigger);
		if (wasSameTrigger) return;
	}

	const menu = el("div", "mur-dropdown-menu");
	const menuId = `mur-dropdown-${++nextDropdownId}`;
	menu.id = menuId;
	menu.tabIndex = -1;
	menu.setAttribute("role", "menu");
	menu.setAttribute("aria-orientation", "vertical");
	if (options.width) menu.style.width = options.width;

	const buttons = new Map<string, { button: HTMLButtonElement; item: DropdownItem }>();
	const renderItems = (items: readonly DropdownItem[]) => {
		const focused = menu.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
		const ids = new Set(items.map((item) => item.id));
		for (const [id, state] of buttons) {
			if (!ids.has(id)) {
				state.button.remove();
				buttons.delete(id);
			}
		}
		items.forEach((item, index) => {
			let state = buttons.get(item.id);
			if (!state) {
				const button = el("button", "", { type: "button" });
				button.setAttribute("role", "menuitem");
				button.addEventListener("click", (event) => {
					event.stopPropagation();
					const current = buttons.get(item.id)?.item;
					if (current && !current.disabled) {
						closeDropdown();
						current.onClick();
					}
				});
				state = { button, item };
				buttons.set(item.id, state);
			}
			const button = state.button;
			const className = item.danger ? "mur-dropdown-item mur-danger" : "mur-dropdown-item";
			if (button.className !== className) button.className = className;
			if (button.disabled !== Boolean(item.disabled)) button.disabled = Boolean(item.disabled);
			if (!button.firstChild || item.iconHtml !== state.item.iconHtml) {
				button.replaceChildren();
				if (item.iconHtml) button.appendChild(el("span", "mur-dropdown-icon", { innerHTML: item.iconHtml }));
				button.appendChild(el("span", "mur-dropdown-label"));
			}
			if (button.lastChild!.textContent !== item.label) button.lastChild!.textContent = item.label;
			state.item = item;
			if (menu.children[index] !== button) menu.insertBefore(button, menu.children[index]);
		});
		if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
		else if (focused && !focused.isConnected) menu.focus({ preventScroll: true });
	};
	renderItems(items);

	const appContainer = trigger.closest(".mur-app") || document.body;
	appContainer.appendChild(menu);

	const previousAriaHasPopup = trigger.getAttribute("aria-haspopup");
	const previousAriaExpanded = trigger.getAttribute("aria-expanded");
	const previousAriaControls = trigger.getAttribute("aria-controls");
	trigger.setAttribute("aria-haspopup", "menu");
	trigger.setAttribute("aria-expanded", "true");
	trigger.setAttribute("aria-controls", menuId);

	const setStyle = (name: "top" | "left" | "right", value: string) => {
		if (menu.style[name] !== value) menu.style[name] = value;
	};
	const position = () => {
		const triggerRect = trigger.getBoundingClientRect();
		const appRect = appContainer.getBoundingClientRect();
		const menuWidth = menu.offsetWidth;
		const menuHeight = menu.offsetHeight;
		const top = triggerRect.bottom - appRect.top;
		const left = triggerRect.left - appRect.left;

		const preferredTop =
			top + 4 + menuHeight > appRect.height ? triggerRect.top - appRect.top - menuHeight - 4 : top + 4;
		// A background reorder can move the trigger beyond the visible list.
		const minTop = Math.max(0, -appRect.top);
		const maxTop = Math.max(
			minTop,
			Math.min(appRect.height, document.defaultView!.innerHeight - appRect.top) - menuHeight,
		);
		setStyle("top", `${Math.max(minTop, Math.min(preferredTop, maxTop))}px`);

		const alignRightEdge = options.align === "right" || (!options.align && left + menuWidth > appRect.width - 16);

		if (alignRightEdge) {
			const rightOffset = appRect.right - triggerRect.right;
			setStyle("right", `${rightOffset}px`);
			setStyle("left", "auto");
		} else {
			setStyle("left", `${left}px`);
			setStyle("right", "auto");
		}
	};
	position();

	const handleOutsidePointerDown = (e: PointerEvent) => {
		if (!menu.contains(e.target as Node) && !trigger.contains(e.target as Node)) {
			closeDropdown();
		}
	};

	const handleEsc = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			e.preventDefault();
			closeDropdown(true);
		}
	};

	const enabledItems = () => Array.from(menu.querySelectorAll<HTMLButtonElement>(".mur-dropdown-item:not(:disabled)"));
	const focusMenuItem = (offset: number) => {
		const items = enabledItems();
		if (items.length === 0) return;

		const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
		const nextIndex = currentIndex === -1 ? 0 : (currentIndex + offset + items.length) % items.length;
		items[nextIndex].focus();
	};

	const handleMenuKeydown = (e: KeyboardEvent) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			focusMenuItem(1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			focusMenuItem(-1);
		} else if (e.key === "Home") {
			e.preventDefault();
			enabledItems()[0]?.focus();
		} else if (e.key === "End") {
			e.preventDefault();
			const items = enabledItems();
			items[items.length - 1]?.focus();
		} else if (e.key === "Tab") {
			closeDropdown();
		}
	};
	menu.addEventListener("keydown", handleMenuKeydown);
	menu.focus();

	document.addEventListener("pointerdown", handleOutsidePointerDown);
	document.addEventListener("keydown", handleEsc);

	const cleanup = (restoreFocus = false) => {
		menu.remove();
		menu.removeEventListener("keydown", handleMenuKeydown);
		document.removeEventListener("pointerdown", handleOutsidePointerDown);
		document.removeEventListener("keydown", handleEsc);
		restoreAttribute(trigger, "aria-haspopup", previousAriaHasPopup);
		restoreAttribute(trigger, "aria-expanded", previousAriaExpanded);
		restoreAttribute(trigger, "aria-controls", previousAriaControls);
		if (restoreFocus && trigger.isConnected) {
			trigger.focus();
		}
		if (activeDropdown?.menu === menu) activeDropdown = null;
	};

	activeDropdown = {
		menu,
		trigger,
		cleanup,
		update(items) {
			if (!items.length) {
				cleanup();
				return;
			}
			renderItems(items);
			position();
		},
	};
}

export function closeDropdown(restoreFocus = false, within?: HTMLElement) {
	if (activeDropdown && (!within || within.contains(activeDropdown.trigger))) {
		activeDropdown.cleanup(restoreFocus);
	}
}

export function updateDropdown(trigger: HTMLElement, items: readonly DropdownItem[]): void {
	if (activeDropdown?.trigger === trigger) activeDropdown.update(items);
}

function restoreAttribute(element: HTMLElement, name: string, value: string | null) {
	if (value === null) {
		element.removeAttribute(name);
		return;
	}

	element.setAttribute(name, value);
}
