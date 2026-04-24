const isDev = typeof process !== "undefined" && process.env?.NODE_ENV !== "production";

export function devFreeze<T extends object>(obj: T): T {
	if (!isDev) return obj;

	const propNames = Object.getOwnPropertyNames(obj);
	for (const name of propNames) {
		const value = (obj as Record<string, unknown>)[name];
		if (value && typeof value === "object") {
			devFreeze(value);
		}
	}
	return Object.freeze(obj);
}
