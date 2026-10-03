import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "./store";

test("subscribe emits the selected value until unsubscribed and ignores unrelated updates", () => {
	const items = ["first"];
	const store = new Store({ count: 0, items });

	const counts: number[] = [];
	const itemRefs: string[][] = [];

	const unsubscribe = store.subscribe(
		(state) => state.count,
		(count) => counts.push(count),
	);
	store.subscribe(
		(state) => state.items,
		(selectedItems) => itemRefs.push(selectedItems),
	);

	store.set({ items });
	store.set({ count: 1 });

	assert.deepEqual(counts, [0, 1]);
	assert.deepEqual(itemRefs, [items]);
	unsubscribe();
	store.set({ count: 2 });
	assert.deepEqual(counts, [0, 1]);
});

test("onChange only fires on future selected value changes", () => {
	const store = new Store({ count: 0 });
	const values: number[] = [];

	store.onChange(
		(state) => state.count,
		(count) => values.push(count),
	);

	store.set({ count: 0 });
	store.set({ count: 1 });

	assert.deepEqual(values, [1]);
});
