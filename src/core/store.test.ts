import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "./store";

test("set notifies selector and hot subscribers", () => {
	const store = new Store({ count: 0 });

	const selectorValues: number[] = [];
	const hotValues: number[] = [];

	store.subscribe(
		(state) => state.count,
		(count) => selectorValues.push(count),
	);
	store.subscribeHot((state) => hotValues.push(state.count));

	store.set({ count: 1 });

	assert.deepEqual(selectorValues, [1]);
	assert.deepEqual(hotValues, [1]);
});

test("mutateHot bypasses selector subscribers", () => {
	const store = new Store({ count: 0 });

	let selectorRuns = 0;
	const selectorValues: number[] = [];
	const hotValues: number[] = [];

	store.subscribe(
		(state) => {
			selectorRuns++;
			return state.count;
		},
		(count) => selectorValues.push(count),
	);
	store.subscribeHot((state) => hotValues.push(state.count));

	store.mutateHot((state) => {
		state.count = 1;
	});

	assert.equal(selectorRuns, 1);
	assert.deepEqual(selectorValues, []);
	assert.deepEqual(hotValues, [1]);
});

test("selector subscribers only fire when the selected value changes", () => {
	const items = ["first"];
	const store = new Store({ count: 0, items });

	const counts: number[] = [];
	const itemRefs: string[][] = [];

	store.subscribe(
		(state) => state.count,
		(count) => counts.push(count),
	);
	store.subscribe(
		(state) => state.items,
		(selectedItems) => itemRefs.push(selectedItems),
	);

	store.set({ items });
	store.set({ count: 1 });

	assert.deepEqual(counts, [1]);
	assert.deepEqual(itemRefs, []);
});

test("unsubscribe removes selector and hot subscribers", () => {
	const store = new Store({ count: 0 });

	const selectorValues: number[] = [];
	const hotValues: number[] = [];

	const unsubscribeSelector = store.subscribe(
		(state) => state.count,
		(count) => selectorValues.push(count),
	);
	const unsubscribeHot = store.subscribeHot((state) => hotValues.push(state.count));

	store.set({ count: 1 });
	unsubscribeSelector();
	unsubscribeHot();
	store.set({ count: 2 });

	assert.deepEqual(selectorValues, [1]);
	assert.deepEqual(hotValues, [1]);
});
