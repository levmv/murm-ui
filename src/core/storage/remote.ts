import type { ChatSession, ChatSessionMeta, ChatStorage, PaginatedSessions } from "../types";

export class RemoteStorage implements ChatStorage {
	constructor(
		private baseUrl: string,
		private getToken: () => string | null,
	) {}

	private get headers() {
		const token = this.getToken();
		return {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		};
	}

	private getPath(suffix = ""): string {
		const base = this.baseUrl.replace(/\/+$/, "");
		return `${base}/api/chats${suffix}`;
	}

	async loadSessions(limit: number, cursor?: { updatedAt: number; id: string }): Promise<PaginatedSessions> {
		const params = new URLSearchParams({ limit: limit.toString() });
		if (cursor) {
			params.append("cursor", cursor.updatedAt.toString());
			params.append("cursorId", cursor.id);
		}

		const res = await fetch(`${this.getPath()}?${params.toString()}`, { headers: this.headers });
		if (!res.ok) throw new Error("Failed to load chats");
		return res.json();
	}

	async loadOne(id: string): Promise<ChatSession | null> {
		const res = await fetch(this.getPath(`/${encodeURIComponent(id)}`), {
			headers: this.headers,
		});
		if (res.status === 404) return null;
		if (!res.ok) throw new Error("Failed to load chat");
		return res.json();
	}

	async save(session: ChatSession): Promise<void> {
		const res = await fetch(this.getPath(`/${encodeURIComponent(session.id)}`), {
			method: "PUT",
			headers: this.headers,
			body: JSON.stringify(session),
		});
		if (!res.ok) throw new Error("Failed to save chat");
	}

	async updateMetadata(id: string, meta: Partial<ChatSessionMeta>): Promise<void> {
		const res = await fetch(this.getPath(`/${encodeURIComponent(id)}/meta`), {
			method: "POST",
			headers: this.headers,
			body: JSON.stringify(meta),
		});
		if (!res.ok) throw new Error("Failed to update chat metadata");
	}

	async delete(id: string): Promise<void> {
		const res = await fetch(this.getPath(`/${encodeURIComponent(id)}`), {
			method: "DELETE",
			headers: this.headers,
		});
		if (!res.ok) throw new Error("Failed to delete chat");
	}
}
