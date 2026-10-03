import type { ChatSession, ChatSessionMeta, ChatStorage, PaginatedSessions } from "../types";

const DB_VERSION = 6;
const STORE_META = "session_meta";
const STORE_MSGS = "session_messages";
const INDEX_META_BY_PINNED_UPDATED_ID = "by_pinned_updated_id";
const INDEXED_PINNED_FIELD = "isPinnedKey";

type StoredSessionMeta = ChatSessionMeta & { [INDEXED_PINNED_FIELD]: number };

export class IndexedDBStorage implements ChatStorage {
	private connection: Promise<IDBDatabase> | null = null;

	constructor(private dbName: string = "MurmDB") {}

	private getDB(): Promise<IDBDatabase> {
		if (this.connection) return this.connection;

		const opening = new Promise<IDBDatabase>((resolve, reject) => {
			if (typeof indexedDB === "undefined") {
				throw new Error("IndexedDB is not supported in this environment.");
			}

			const request = indexedDB.open(this.dbName, DB_VERSION);

			request.onerror = () => {
				reject(request.error);
			};
			request.onblocked = () => {
				reject(new Error("Database upgrade blocked. Close other tabs or DevTools and refresh."));
			};
			request.onsuccess = () => {
				if (this.connection !== opening) {
					request.result.close();
					reject(new Error("Database was closed while opening."));
				} else {
					resolve(request.result);
				}
			};

			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;
				const tx = (event.target as IDBOpenDBRequest).transaction;
				if (!tx) throw new Error("IndexedDB upgrade transaction is unavailable.");

				let metaStore: IDBObjectStore;
				if (!db.objectStoreNames.contains(STORE_META)) {
					metaStore = db.createObjectStore(STORE_META, {
						keyPath: "id",
					});
				} else {
					metaStore = tx.objectStore(STORE_META);
				}

				if (metaStore.indexNames.contains("by_updated")) {
					metaStore.deleteIndex("by_updated");
				}
				if (metaStore.indexNames.contains("by_updated_id")) {
					metaStore.deleteIndex("by_updated_id");
				}
				if (metaStore.indexNames.contains(INDEX_META_BY_PINNED_UPDATED_ID)) {
					metaStore.deleteIndex(INDEX_META_BY_PINNED_UPDATED_ID);
				}
				metaStore.createIndex(INDEX_META_BY_PINNED_UPDATED_ID, [INDEXED_PINNED_FIELD, "updatedAt", "id"], {
					unique: false,
				});

				if (!db.objectStoreNames.contains(STORE_MSGS)) {
					db.createObjectStore(STORE_MSGS, { keyPath: "id" });
				}

				const normalizeReq = metaStore.openCursor();
				normalizeReq.onsuccess = () => {
					const cursor = normalizeReq.result;
					if (!cursor) return;
					const value = cursor.value;
					if (typeof value[INDEXED_PINNED_FIELD] !== "number") {
						cursor.update(this.toStoredMeta(value));
					}
					cursor.continue();
				};
			};
		});

		this.connection = opening;
		void opening.catch(() => {
			if (this.connection === opening) this.connection = null;
		});
		return opening;
	}

	async loadSessions(limit: number, cursor?: ChatSessionMeta): Promise<PaginatedSessions> {
		return this.runTx(STORE_META, (tx, resolve, reject) => {
			const index = tx.objectStore(STORE_META).index(INDEX_META_BY_PINNED_UPDATED_ID);
			const sessions: ChatSessionMeta[] = [];

			const range = cursor
				? IDBKeyRange.upperBound([this.toPinnedKey(cursor.isPinned), cursor.updatedAt, cursor.id], true)
				: null;
			const request = index.openCursor(range, "prev");

			request.onsuccess = () => {
				const dbCursor = request.result;
				if (!dbCursor) {
					resolve({ items: sessions, hasMore: false });
					return;
				}

				sessions.push(this.fromStoredMeta(dbCursor.value));

				if (sessions.length <= limit) {
					dbCursor.continue();
				} else {
					sessions.pop();
					resolve({ items: sessions, hasMore: true });
				}
			};

			request.onerror = () => reject(request.error);
		});
	}

	async loadOne(id: string): Promise<ChatSession | null> {
		return this.runTx([STORE_META, STORE_MSGS], (tx, resolve) => {
			const metaReq = tx.objectStore(STORE_META).get(id);
			const msgReq = tx.objectStore(STORE_MSGS).get(id);

			tx.oncomplete = () => {
				if (!metaReq.result || !msgReq.result) resolve(null);
				else resolve({ ...this.fromStoredMeta(metaReq.result), messages: msgReq.result.messages });
			};
		});
	}

	async updateMetadata(id: string, meta: Partial<ChatSessionMeta>): Promise<void> {
		return this.runTx<void>(
			STORE_META,
			(tx, resolve) => {
				tx.oncomplete = () => resolve();
				const store = tx.objectStore(STORE_META);
				const getReq = store.get(id);

				getReq.onsuccess = () => {
					const existing = getReq.result;
					if (existing) {
						store.put(
							this.toStoredMeta({
								...existing,
								...meta,
								isPinned: typeof meta.isPinned === "boolean" ? meta.isPinned : Boolean(existing.isPinned),
							}),
						);
					}
				};
			},
			"readwrite",
		);
	}

	async save(session: ChatSession): Promise<void> {
		return this.runTx<void>(
			[STORE_META, STORE_MSGS],
			(tx, resolve) => {
				tx.oncomplete = () => resolve();
				const updatedAt = session.updatedAt || Date.now();
				const metaStore = tx.objectStore(STORE_META);
				const messagesStore = tx.objectStore(STORE_MSGS);
				const existingReq = metaStore.get(session.id);
				existingReq.onsuccess = () => {
					const existingPinned = Boolean(existingReq.result?.isPinned);
					const isPinned = typeof session.isPinned === "boolean" ? session.isPinned : existingPinned;
					metaStore.put(this.toStoredMeta({ id: session.id, title: session.title, updatedAt, isPinned }));
					messagesStore.put({ id: session.id, messages: session.messages });
				};
			},
			"readwrite",
		);
	}

	async delete(id: string): Promise<void> {
		return this.runTx<void>(
			[STORE_META, STORE_MSGS],
			(tx, resolve) => {
				tx.oncomplete = () => resolve();
				tx.objectStore(STORE_META).delete(id);
				tx.objectStore(STORE_MSGS).delete(id);
			},
			"readwrite",
		);
	}

	close(): void {
		const connection = this.connection;
		this.connection = null;
		connection?.then((db) => db.close()).catch(() => {});
	}

	private async runTx<T>(
		stores: string | string[],
		operation: (tx: IDBTransaction, resolve: (val: T | PromiseLike<T>) => void, reject: (err: unknown) => void) => void,
		mode: IDBTransactionMode = "readonly",
	): Promise<T> {
		const db = await this.getDB();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(stores, mode);
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
			operation(tx, resolve, reject);
		});
	}

	private toStoredMeta(meta: ChatSessionMeta): StoredSessionMeta {
		return {
			id: meta.id,
			title: meta.title,
			updatedAt: meta.updatedAt,
			isPinned: Boolean(meta.isPinned),
			[INDEXED_PINNED_FIELD]: this.toPinnedKey(meta.isPinned),
		};
	}

	private fromStoredMeta(meta: ChatSessionMeta): ChatSessionMeta {
		return {
			id: meta.id,
			title: meta.title,
			updatedAt: meta.updatedAt,
			isPinned: Boolean(meta.isPinned),
		};
	}

	private toPinnedKey(isPinned: boolean | undefined): number {
		return isPinned ? 1 : 0;
	}
}
