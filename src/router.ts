export type RouterType = "hash" | "path" | "none";

export interface RouterConfig {
	type?: RouterType;
	pathPrefix?: string; // Default: '/c/' for path, '#/chat/' for hash
}

export class AppRouter {
	private type: RouterType;
	private prefix: string;
	private handleNavigate?: () => void;

	constructor(config?: RouterConfig) {
		this.type = config?.type || "hash";

		if (this.type === "path") {
			this.prefix = config?.pathPrefix || "/c/";
		} else {
			this.prefix = config?.pathPrefix || "#/chat/";
		}
	}

	public getId(): string | null {
		if (this.type === "none") return null;

		if (this.type === "path") {
			const path = window.location.pathname;
			if (path.startsWith(this.prefix)) {
				return path.slice(this.prefix.length);
			}
		} else if (this.type === "hash") {
			const hash = window.location.hash;
			if (hash.startsWith(this.prefix)) {
				return hash.slice(this.prefix.length);
			}
		}
		return null;
	}

	public hrefFor(id: string): string {
		if (this.type === "none") return "#";
		return `${this.prefix}${id}`;
	}

	public setUrl(id: string | null, replace = false) {
		if (this.type === "none") return;

		const currentId = this.getId();
		if (currentId === id) return;

		const newUrl = id ? `${this.prefix}${id}` : this.type === "path" ? "/" : "#/";

		if (replace) {
			history.replaceState(null, "", newUrl);
		} else {
			history.pushState(null, "", newUrl);
		}
	}

	public listen(onNavigate: (id: string | null) => void) {
		if (this.type === "none") return;

		const eventType = this.type === "path" ? "popstate" : "hashchange";

		this.handleNavigate = () => {
			onNavigate(this.getId());
		};

		window.addEventListener(eventType, this.handleNavigate);
	}

	public destroy() {
		if (this.type === "none" || !this.handleNavigate) return;
		const eventType = this.type === "path" ? "popstate" : "hashchange";
		window.removeEventListener(eventType, this.handleNavigate);
	}
}
