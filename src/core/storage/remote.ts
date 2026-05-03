import type { ChatSession, ChatSessionMeta, ChatStorage, PaginatedSessions } from "../types";

export interface RemoteStorageOptions {
	/**
	 * Limits the number of messages sent during a save() operation.
	 * WARNING: If you use this, your backend must upsert messages rather than
	 * overwrite the entire chat record when the partial save header is present.
	 */
	saveLimit?: number;
}

export class RemoteStorage implements ChatStorage {
	constructor(
		private baseUrl: string,
		private getToken: () => string | null,
		private options?: RemoteStorageOptions,
	) {}

	private get headers(): Record<string, string> {
		const token = this.getToken();
		return {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		};
	}

	private getPath(suffix = ""): string {
		const base = this.baseUrl.replace(/\/+$/, "");
		return `${base}/chats${suffix}`;
	}

	async loadSessions(limit: number, cursor?: ChatSessionMeta): Promise<PaginatedSessions> {
		const params = new URLSearchParams({ limit: limit.toString() });
		if (cursor) {
			params.append("cursor", cursor.updatedAt.toString());
			params.append("cursorId", cursor.id);
			params.append("cursorPinned", String(Boolean(cursor.isPinned)));
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
		const limit = this.getSaveLimit();
		let payload = session;
		const headers = this.headers;

		if (limit && session.messages.length > limit) {
			payload = {
				...session,
				messages: session.messages.slice(-limit),
			};
			headers["X-Murm-Save-Mode"] = "partial";
		}

		const res = await fetch(this.getPath(`/${encodeURIComponent(session.id)}`), {
			method: "PUT",
			headers,
			body: JSON.stringify(payload),
		});
		if (!res.ok) throw new Error("Failed to save chat");
	}

	private getSaveLimit(): number | null {
		const limit = this.options?.saveLimit;
		if (typeof limit !== "number" || !Number.isFinite(limit)) return null;

		const wholeLimit = Math.floor(limit);
		return wholeLimit > 0 ? wholeLimit : null;
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
