import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexedDBStorage } from "./indexed-db";

test("close() handles a pending dbPromise when db is not yet set", async () => {
	const storage = new IndexedDBStorage("test-db");
	const raw = storage as unknown as Record<string, unknown>;

	let closed = false;
	const fakeDb = { close: () => (closed = true) };

	// Simulate the state during DB opening: db is null, dbPromise is pending
	raw.db = null;
	raw.dbPromise = Promise.resolve(fakeDb);

	storage.close();

	assert.equal(raw.dbPromise, null, "dbPromise should be nulled out");

	// Let the .then() callback execute
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(closed, true, "db.close() should be called when the promise resolves");
});
