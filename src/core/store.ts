export class Store<T extends object> {
	private state: T;
	private selectorListeners: Set<(state: T) => void> = new Set();
	private hotListeners: Set<(state: T) => void> = new Set();

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
		this.notifySelectorListeners();
		this.notifyHotListeners();
	}

	/**
	 * HIGH-PERFORMANCE HOT PATH ONLY.
	 * Mutates state in-place to prevent GC thrashing during LLM streaming.
	 * NOTE: This intentionally bypasses selector subscribers so hot updates
	 * do not run every selector on every token. Only hot subscribers are notified.
	 */
	mutateHot(recipe: (state: T) => void) {
		recipe(this.state);
		this.notifyHotListeners();
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

		this.selectorListeners.add(wrappedListener);
		return () => this.selectorListeners.delete(wrappedListener);
	}

	/**
	 * Subscribes to normal set() updates and hot in-place mutations.
	 * Use sparingly for render paths that must observe high-frequency mutable state.
	 */
	subscribeHot(listener: (state: T) => void): () => void {
		this.hotListeners.add(listener);
		return () => this.hotListeners.delete(listener);
	}

	public clearAllListeners(): void {
		this.selectorListeners.clear();
		this.hotListeners.clear();
	}

	private notifySelectorListeners() {
		for (const listener of this.selectorListeners) {
			listener(this.state);
		}
	}

	private notifyHotListeners() {
		for (const listener of this.hotListeners) {
			listener(this.state);
		}
	}
}
