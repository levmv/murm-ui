import type { ChatSession, ChatSessionMeta, ChatStorage, PaginatedSessions } from "../types";

const DB_VERSION = 4;
const STORE_META = "session_meta";
const STORE_MSGS = "session_messages";
const INDEX_META_BY_UPDATED_ID = "by_updated_id";

export class IndexedDBStorage implements ChatStorage {
	private db: IDBDatabase | null = null;
	private dbPromise: Promise<IDBDatabase> | null = null;

	constructor(private dbName: string = "LLMChatDB") {}

	private async getDB(): Promise<IDBDatabase> {
		if (this.db) return this.db;
		if (this.dbPromise) return this.dbPromise;

		this.dbPromise = new Promise((resolve, reject) => {
			try {
				if (typeof indexedDB === "undefined") {
					throw new Error("IndexedDB is not supported in this environment.");
				}

				const request = indexedDB.open(this.dbName, DB_VERSION);

				request.onerror = () => {
					this.dbPromise = null;
					reject(request.error);
				};
				request.onblocked = () => {
					this.dbPromise = null;
					reject(new Error("Database upgrade blocked. Close other tabs or DevTools and refresh."));
				};
				request.onsuccess = () => {
					this.db = request.result;
					resolve(this.db);
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
					if (!metaStore.indexNames.contains(INDEX_META_BY_UPDATED_ID)) {
						metaStore.createIndex(INDEX_META_BY_UPDATED_ID, ["updatedAt", "id"], { unique: false });
					}

					if (!db.objectStoreNames.contains(STORE_MSGS)) {
						db.createObjectStore(STORE_MSGS, { keyPath: "id" });
					}
				};
			} catch (err) {
				this.dbPromise = null;
				reject(err);
			}
		});

		return this.dbPromise;
	}

	async loadSessions(limit: number, cursor?: { updatedAt: number; id: string }): Promise<PaginatedSessions> {
		return this.runTx(STORE_META, (tx, resolve, reject) => {
			const index = tx.objectStore(STORE_META).index(INDEX_META_BY_UPDATED_ID);
			const sessions: ChatSessionMeta[] = [];

			const range = cursor ? IDBKeyRange.upperBound([cursor.updatedAt, cursor.id], true) : null;
			const request = index.openCursor(range, "prev");

			request.onsuccess = () => {
				const dbCursor = request.result;
				if (!dbCursor) {
					resolve({ items: sessions, hasMore: false });
					return;
				}

				sessions.push(dbCursor.value);

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
				else resolve({ ...metaReq.result, messages: msgReq.result.messages });
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
					if (existing) store.put({ ...existing, ...meta });
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
				tx.objectStore(STORE_META).put({ id: session.id, title: session.title, updatedAt });
				tx.objectStore(STORE_MSGS).put({ id: session.id, messages: session.messages });
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
		if (this.db) {
			this.db.close();
			this.db = null;
		}
		if (this.dbPromise) {
			this.dbPromise.then((db) => db.close()).catch(() => {});
			this.dbPromise = null;
		}
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
}
