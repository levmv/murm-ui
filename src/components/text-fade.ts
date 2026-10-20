/**
 * Fades in words of growing text. Each render builds a fresh tree, and reconciliation keeps
 * nodes by position, so every word of a block with animating words is wrapped: positions stay
 * stable as text grows, and a kept span continues its animation. Finished blocks render as plain
 * text. New words start on a shared timeline that compresses on fast streams.
 */

/** Matches `.mur-fading` in feed.css. */
const FADE_MS = 200;
/** Animations start with a frame after rendering. */
const SETTLE_MS = 50;
const STEP_MS = 25;
/** New words start at most this long after they render. */
const MAX_LAG_MS = 300;
/** Text already this long when fading starts was shown before, e.g. on switching conversations. */
const SHOWN_CHARS = 120;

const BLOCKS = new Set(["P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "TD", "TH"]);
const INLINE = new Set(["A", "B", "CODE", "DEL", "EM", "I", "S", "STRONG"]);
// Han and kana characters fade one by one; other words split at whitespace.
const WORD = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]|[^\s\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]+/gu;

interface Run {
	node: Text;
	at: number;
	block: Element;
}

interface Fading {
	at: number;
	delay: number;
	ends: number;
}

export class TextFade {
	/** Length of text already shown; unset before the first render. */
	private shown?: number;
	/** Animating words in text order. */
	private fading: Fading[] = [];
	private nextStart = 0;

	/** Wraps words of a fresh render; `now` is the time it will be shown. */
	apply(root: Element, now: number): void {
		const runs: Run[] = [];
		const length = collect(root, null, runs, 0);
		if (this.shown === undefined) {
			this.shown = length > SHOWN_CHARS ? length : 0;
		}
		const shown = this.shown;
		this.shown = length;
		let done = 0;
		while (done < this.fading.length && this.fading[done].ends <= now) done++;
		const fading = this.fading.slice(done);
		const from = fading.length > 0 ? Math.min(fading[0].at, shown) : shown;

		// A block keeps its spans while any of its words animate.
		const ends = new Map<Element, number>();
		for (const run of runs) ends.set(run.block, run.at + run.node.data.length);
		const active = runs.filter((run) => ends.get(run.block)! > from);

		let added = 0;
		for (const run of active) {
			for (const match of run.node.data.matchAll(WORD)) if (run.at + match.index! >= shown) added++;
		}
		const base = Math.max(now, this.nextStart);
		const step = added > 0 ? Math.max(0, Math.min(STEP_MS, (now + MAX_LAG_MS - base) / added)) : 0;
		let start = base;
		let next = 0;
		const doc = root.ownerDocument;
		for (const run of active) {
			const text = run.node.data;
			const words = doc.createDocumentFragment();
			let end = 0;
			for (const match of text.matchAll(WORD)) {
				const at = run.at + match.index!;
				if (match.index! > end) words.append(text.slice(end, match.index));
				end = match.index! + match[0].length;
				while (next < fading.length && fading[next].at < at) next++;
				let word = fading[next]?.at === at ? fading[next] : undefined;
				if (!word && at >= shown) {
					word = { at, delay: Math.round(start - now), ends: start + FADE_MS + SETTLE_MS };
					fading.push(word);
					start += step;
				}
				const span = doc.createElement("span");
				span.className = word ? "mur-word mur-fading" : "mur-word";
				// Kept spans compare equal, so reconciliation leaves running animations alone.
				if (word && word.delay > 0) span.setAttribute("style", `animation-delay: ${word.delay}ms`);
				span.textContent = match[0];
				words.append(span);
			}
			if (end < text.length) words.append(text.slice(end));
			run.node.replaceWith(words);
		}
		this.nextStart = Math.max(this.nextStart, start);
		this.fading = fading;
	}

	/** Milliseconds until running animations end. */
	remaining(now: number): number {
		const last = this.fading[this.fading.length - 1];
		return last ? Math.max(0, last.ends - now) : 0;
	}
}

/** Replaces word spans with their text once animations end. */
export function unwrapWords(root: Element): void {
	const parents = new Set<Node>();
	for (const span of root.querySelectorAll("span.mur-word")) {
		parents.add(span.parentNode!);
		span.replaceWith(...span.childNodes);
	}
	for (const parent of parents) parent.normalize();
}

/** Records eligible text in document order and returns the text length after it. */
function collect(parent: Element, block: Element | null, runs: Run[], length: number): number {
	for (let node = parent.firstChild; node; node = node.nextSibling) {
		if (node.nodeType === Node.TEXT_NODE) {
			if (block) {
				runs.push({ node: node as Text, at: length, block });
				length += (node as Text).data.length;
			}
		} else if (node.nodeType === Node.ELEMENT_NODE) {
			const element = node as Element;
			// Code blocks keep their structure; text in unknown markup, such as widgets, is skipped.
			if (element.tagName === "PRE") continue;
			const inner = BLOCKS.has(element.tagName) ? element : block && INLINE.has(element.tagName) ? block : null;
			length = collect(element, inner, runs, length);
		}
	}
	return length;
}
