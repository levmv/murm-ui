export class Store<T extends object> {
	private state: T;
	private listeners: Set<(state: T) => void> = new Set();

	constructor(initialState: T) {
		this.state = initialState;
	}

	get(): T {
		return this.state;
	}

	/**
	 * Standard immutable update.
	 * Use this for 99% of state changes (sessions, active chat, etc).
	 * Safely triggers all relevant selector-based subscribers.
	 */
	set(partialState: Partial<T>) {
		this.state = { ...this.state, ...partialState };
		this.notify();
	}
	/**
	 * HIGH-PERFORMANCE HOT PATH ONLY.
	 * Mutates state in-place to prevent GC thrashing during LLM streaming.
	 * NOTE: Because references do not change, selector-based subscribers
	 * will NOT fire. Only global subscribers will catch this update.
	 */
	mutate(recipe: (state: T) => void) {
		recipe(this.state);
		this.notify();
	}

	/**
	 * Subscribes to a specific slice of state.
	 * The listener only fires when the selected value actually changes.
	 */
	subscribe<U>(selector: (state: T) => U, listener: (selectedState: U) => void): () => void {
		let lastSlice = selector(this.state);

		const wrappedListener = (state: T) => {
			const currentSlice = selector(state);

			if (currentSlice !== lastSlice) {
				lastSlice = currentSlice;
				listener(currentSlice);
			}
		};

		this.listeners.add(wrappedListener);
		return () => this.listeners.delete(wrappedListener);
	}

	/**
	 * Subscribes to ALL store updates, including in-place mutations.
	 * Use sparingly (e.g., for high-performance streaming updates).
	 */
	subscribeGlobal(listener: (state: T) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	public clearAllListeners(): void {
		this.listeners.clear();
	}

	private notify() {
		for (const listener of this.listeners) {
			listener(this.state);
		}
	}
}
