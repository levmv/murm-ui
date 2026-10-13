import type { ContentBlock } from "../core/types";

/** One timer shared by all mounted chunks of a streaming message. */
export class MessageStall {
	private blocks: { id: string; value: string | ContentBlock }[] = [];
	private position = 0;
	private changed = false;
	private stalled = false;
	private timer?: ReturnType<typeof setTimeout>;
	render?: (stalled: boolean) => void;

	constructor(private readonly delay: number) {}

	begin(): void {
		this.position = 0;
		this.changed = false;
		this.render = undefined;
	}

	observe(id: string, value: string | ContentBlock, markdownPending = false): void {
		const previous = this.blocks[this.position];
		if (markdownPending) value = previous?.id === id ? previous.value : "";
		const same =
			previous?.id === id &&
			(typeof value === "string"
				? previous.value === value
				: typeof previous.value !== "string" && sameFields(previous.value, value));
		if (!same) {
			const snapshot = typeof value === "string" ? value : { ...value };
			if (previous?.id === id) previous.value = snapshot;
			else this.blocks[this.position] = { id, value: snapshot };
			this.changed = true;
		}
		this.position++;
	}

	/** Async Markdown can finish between feed updates. */
	rendered(id: string, text: string): void {
		if (!this.render) return;
		const block = this.blocks.find((block) => block.id === id);
		if (!block || block.value === text) return;
		block.value = text;
		this.restart();
		this.render(false);
	}

	/** Called after every chunk has reported its displayed blocks and the last has bound render. */
	finish(): boolean {
		if (!this.render) return false;
		if (this.blocks.length !== this.position) {
			this.blocks.length = this.position;
			this.changed = true;
		}
		if (this.changed || (this.timer === undefined && !this.stalled)) this.restart();
		this.render(this.stalled);
		return true;
	}

	private restart(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.stalled = false;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.stalled = true;
			this.render?.(true);
		}, this.delay);
	}

	destroy(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.render = undefined;
		this.blocks.length = 0;
	}
}

function sameFields(a: ContentBlock, b: ContentBlock): boolean {
	const previous = a as unknown as Record<string, unknown>;
	const current = b as unknown as Record<string, unknown>;
	for (const key in previous) if (previous[key] !== current[key]) return false;
	for (const key in current) if (previous[key] !== current[key]) return false;
	return true;
}
