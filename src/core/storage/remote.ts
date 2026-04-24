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

	async loadSessions(limit: number, cursor?: { updatedAt: number; id: string }): Promise<PaginatedSessions> {
		const url = new URL(`${this.baseUrl}/api/chats`);
		url.searchParams.append("limit", limit.toString());
		if (cursor) {
			url.searchParams.append("cursor", cursor.updatedAt.toString());
			url.searchParams.append("cursorId", cursor.id);
		}

		const res = await fetch(url.toString(), { headers: this.headers });
		if (!res.ok) throw new Error("Failed to load chats");
		return res.json();
	}

	async loadOne(id: string): Promise<ChatSession | null> {
		const res = await fetch(`${this.baseUrl}/api/chats/${id}`, {
			headers: this.headers,
		});
		if (res.status === 404) return null;
		if (!res.ok) throw new Error("Failed to load chat");
		return res.json();
	}

	async save(session: ChatSession): Promise<void> {
		const res = await fetch(`${this.baseUrl}/api/chats/${session.id}`, {
			method: "PUT",
			headers: this.headers,
			body: JSON.stringify(session),
		});
		if (!res.ok) throw new Error("Failed to save chat");
	}

	async updateMetadata(id: string, meta: Partial<ChatSessionMeta>): Promise<void> {
		const res = await fetch(`${this.baseUrl}/api/chats/${id}/meta`, {
			method: "POST",
			headers: this.headers,
			body: JSON.stringify(meta),
		});
		if (!res.ok) throw new Error("Failed to update chat metadata");
	}

	async delete(id: string): Promise<void> {
		const res = await fetch(`${this.baseUrl}/api/chats/${id}`, {
			method: "DELETE",
			headers: this.headers,
		});
		if (!res.ok) throw new Error("Failed to delete chat");
	}
}
