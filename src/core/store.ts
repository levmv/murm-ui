export class Store<T extends object> {
	private state: T;
	private selectorListeners: Set<(state: T) => void> = new Set();

	constructor(initialState: T) {
		this.state = initialState;
	}

	get(): T {
		return this.state;
	}

	/** Replaces the state object and notifies subscribers. */
	set(partialState: Partial<T>) {
		this.state = { ...this.state, ...partialState };
		this.notifySelectorListeners();
	}

	/**
	 * Fires immediately, then when set() changes the selected value by reference.
	 */
	subscribe<U>(selector: (state: T) => U, listener: (selectedState: U) => void): () => void {
		const initialSlice = selector(this.state);
		listener(initialSlice);
		return this.onChangeFrom(selector, listener, initialSlice);
	}

	/** Like subscribe(), without the immediate call. */
	public onChange<U>(selector: (state: T) => U, listener: (selectedState: U) => void): () => void {
		return this.onChangeFrom(selector, listener, selector(this.state));
	}

	private onChangeFrom<U>(
		selector: (state: T) => U,
		listener: (selectedState: U) => void,
		initialSlice: U,
	): () => void {
		let lastSlice = initialSlice;
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

	public clearAllListeners(): void {
		this.selectorListeners.clear();
	}

	private notifySelectorListeners() {
		for (const listener of this.selectorListeners) {
			listener(this.state);
		}
	}
}
