import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { IndexedDBStorage } from "./indexed-db";

function installIndexedDB(t: TestContext) {
	function request() {
		const close = t.mock.fn();
		const db = {
			close,
			transaction() {
				assert.equal(close.mock.callCount(), 0, "cannot transact on a closed connection");
				const tx = {
					objectStore: () => ({ get: () => ({ result: null }) }),
					oncomplete: null as (() => void) | null,
				};
				queueMicrotask(() => tx.oncomplete?.());
				return tx;
			},
		};
		return {
			result: db,
			error: new Error("open failed"),
			onsuccess: null as (() => void) | null,
			onblocked: null as (() => void) | null,
			onerror: null as (() => void) | null,
		};
	}
	const open = t.mock.fn(request);
	const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
	Object.defineProperty(globalThis, "indexedDB", { value: { open }, configurable: true });
	t.after(() => {
		if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
		else Reflect.deleteProperty(globalThis, "indexedDB");
	});
	return open;
}

for (const reason of ["close", "blocked"] as const) {
	test(`reopens after ${reason} during a pending connection`, async (t) => {
		const open = installIndexedDB(t);
		const storage = new IndexedDBStorage("test-db");
		const first = storage.loadOne("session");
		const firstRequest = open.mock.calls[0].result!;
		const rejected = assert.rejects(first, /closed|blocked/);
		if (reason === "close") storage.close();
		else {
			firstRequest.onblocked!();
			await rejected;
		}

		const second = storage.loadOne("session");
		assert.equal(open.mock.callCount(), 2);
		firstRequest.onsuccess!();
		await rejected;
		assert.equal(firstRequest.result.close.mock.callCount(), 1);

		open.mock.calls[1].result!.onsuccess!();
		assert.equal(await second, null);
		assert.equal(await storage.loadOne("session"), null);
		assert.equal(open.mock.callCount(), 2, "reuse the new connection");
		storage.close();
		await Promise.resolve();
		assert.equal(open.mock.calls[1].result!.result.close.mock.callCount(), 1);
	});
}

test("retries after a synchronous open failure", async (t) => {
	const open = installIndexedDB(t);
	open.mock.mockImplementationOnce(() => {
		throw new Error("unavailable");
	});
	const storage = new IndexedDBStorage("test-db");
	await assert.rejects(storage.loadOne("session"), /unavailable/);
	const retry = storage.loadOne("session");
	assert.equal(open.mock.callCount(), 2);
	open.mock.calls[1].result!.onsuccess!();
	assert.equal(await retry, null);
	storage.close();
});
