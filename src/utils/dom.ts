export function queryOrThrow<T extends HTMLElement>(context: HTMLElement, selector: string): T {
	const el = context.querySelector(selector);
	if (!el) {
		throw new Error(`DOM Error: Required element "${selector}" not found inside the container.`);
	}
	return el as T;
}

export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	props?: Partial<HTMLElementTagNameMap[K]> | null,
	children?: (HTMLElement | string | null | false | undefined)[],
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);

	if (className) {
		element.className = className;
	}

	if (props) {
		Object.assign(element, props);
	}

	if (children) {
		for (const child of children) {
			if (child) element.append(child);
		}
	}

	return element;
}

/** Reconciles against a disposable tree, moving new nodes and retaining matching ones. */
export function syncDOMChildren(target: Node, source: Node) {
	let targetChild = target.firstChild;
	let sourceChild = source.firstChild;

	while (sourceChild !== null) {
		// Save siblings before reconciliation moves or replaces either node.
		const nextSourceChild = sourceChild.nextSibling;
		if (targetChild === null) {
			target.appendChild(sourceChild);
		} else {
			const nextTargetChild = targetChild.nextSibling;

			syncDOMNode(targetChild, sourceChild);

			targetChild = nextTargetChild;
		}
		sourceChild = nextSourceChild;
	}

	while (targetChild !== null) {
		const nextTargetChild = targetChild.nextSibling;
		target.removeChild(targetChild);
		targetChild = nextTargetChild;
	}
}

function syncDOMNode(target: Node, source: Node) {
	if (target.nodeType === Node.TEXT_NODE && source.nodeType === Node.TEXT_NODE) {
		if (target.nodeValue !== source.nodeValue) {
			target.nodeValue = source.nodeValue;
		}
		return;
	}

	if (target.nodeType !== source.nodeType || target.nodeName !== source.nodeName) {
		target.parentNode!.replaceChild(source, target);
		return;
	}

	if (target.nodeType === Node.ELEMENT_NODE) {
		const targetElement = target as HTMLElement;
		const sourceElement = source as HTMLElement;

		const sourceAttributes = sourceElement.attributes;
		const targetAttributes = targetElement.attributes;

		// Attributes are live; iterate backwards so removals do not shift unread entries.
		for (let i = targetAttributes.length - 1; i >= 0; i--) {
			const attrName = targetAttributes[i].name;
			if (!sourceElement.hasAttribute(attrName)) {
				targetElement.removeAttribute(attrName);
			}
		}

		for (let i = 0; i < sourceAttributes.length; i++) {
			const attr = sourceAttributes[i];
			if (targetElement.getAttribute(attr.name) !== attr.value) {
				targetElement.setAttribute(attr.name, attr.value);
			}
		}
	}

	syncDOMChildren(target, source);
}
