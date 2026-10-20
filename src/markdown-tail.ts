/**
 * Streaming text is parsed on every update, so the unfinished end of a reply would flash raw
 * syntax: `**bold` before its closing marker, `[text` before the URL, a table header as a
 * paragraph, a list marker as a heading underline. This adjusts the unfinished end for display:
 * inline markers of the last paragraph close early, an ambiguous last line waits for the next
 * characters, and table headers get their delimiter row ahead of time. It is a cheap heuristic
 * for common chat output, not a parser; finished text always renders unchanged.
 */

/** URL of links whose destination is still streaming. The sanitizer keeps them inert. */
export const INCOMPLETE_LINK_HREF = "murm:incomplete-link";

interface Fence {
	char: string;
	length: number;
	/** Blockquote markers of the opening line; the fence ends with its quote. */
	quote: string;
	depth: number;
}

/** Block state after complete lines. */
interface Blocks {
	fence?: Fence;
	math: boolean;
	/** Content column of the list item above; indented code starts four columns further. */
	listOffset: number;
	/** The last line is paragraph text, which indented lines continue lazily. */
	paragraph: boolean;
	/** The last non-blank line is indented code. */
	indented: boolean;
	/** Start of the line after the last code line; paragraph repairs stay below it. */
	afterCode: number;
}

interface Opener {
	/** `*`, `_`, `~` or `[` for links and images. */
	char: string;
	length: number;
	at: number;
}

const QUOTE = /^(?: {0,3}>[ \t]?)+/;
const QUOTE_MARKER = /^ {0,3}>[ \t]?/;
// A fence may open on the line of its list item marker.
const FENCE_OPEN = /^\s*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*(`{3,}|~{3,})/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
const FENCE_CLOSE_PREFIX = /^\s*(`+|~+)$/;
const DISPLAY_MATH = /\$\$|\\\[|\\\]/g;
const INLINE_CODE = /`+[^`]*`+/g;
// Trimmed last lines that the next characters decide: heading level, setext underline, thematic
// break or list marker, ordered list number, task checkbox, code fence and its language.
const AMBIGUOUS_LINE =
	/^(?:#{1,6}|[-*+_=]+|\d{1,9}[.)]?|`{1,2}|~{1,2})?$|^(?:[-*+]|\d{1,9}[.)])\s+\[[ xX]?\]?$|^(?:(?:[-*+]|\d{1,9}[.)])\s+)*(?:`{3,}|~{3,})/;
// Lines that start a new block, and lines after which a paragraph cannot continue.
const BLOCK_START = /^\s*(?:[-*+]\s|\d{1,9}[.)]\s|#{1,6}(?:\s|$)|\||`{3,}|~{3,})/;
const BLOCK_END = /^\s*(?:#{1,6}(?:\s|$)|\||`{3,}|~{3,}|[-*_=]{3,}\s*$|=+\s*$)/;
const TABLE_ROW = /^\s*\|/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])[ \t]+/;
const ESCAPED_PIPE = /\\\|/g;
// Patterns for trimmed lines avoid backtracking over whitespace on both sides.
const DELIMITER_ROW = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/;
const DELIMITER_CELL = /^:?-+:?$/;
const PARTIAL_DELIMITER_ROW = /^\s*\|[\s:|-]*$/;
const EMPTY_ROW = /^\s*\|[\s|]*$/;
const MARKER_CHARS = "*_~`\\";
const TAG_START = /^\/?(?:[A-Za-z][\w-]*)?$/;
const AUTOLINK_START = /^[A-Za-z][\w+.-]*:[^\s<>]*$/;
const SPACE = /\s/;
const NON_SPACE = /\S/;
const DIGIT = /\d/;
const PUNCTUATION = /[\p{P}\p{S}]/u;

/** Returns text for displaying a streaming tail. */
export function stabilizeMarkdownTail(text: string): string {
	const lineStart = text.lastIndexOf("\n") + 1;
	const head = text.slice(0, lineStart);
	const last = text.slice(lineStart);
	const [quote, line] = splitQuote(last);
	const blocks = scanBlocks(head);
	const { fence, math } = blocks;
	if (fence) {
		const code = insideQuotes(last, fence.depth);
		// A last line of quote markers only may still continue the fence.
		if (code !== undefined || !NON_SPACE.test(line)) {
			// Fence characters may be the closing fence still arriving.
			const close = code === undefined ? null : FENCE_CLOSE_PREFIX.exec(code);
			if (close && close[1][0] === fence.char) return head;
			// marked renders a quoted fence without content lines as paragraph text.
			return last ? text : text + fence.quote;
		}
	}
	if (math || (NON_SPACE.test(line) ? isIndentedCode(line, blocks) : blocks.indented)) return text;

	const prevStart = lineStartAt(head, head.length - 1);
	const [prevQuote, prev] = head ? splitQuote(head.slice(prevStart, head.length - 1)) : ["", undefined];
	const beforePrev =
		prevStart > 0 ? splitQuote(head.slice(lineStartAt(head, prevStart - 1), prevStart - 1))[1] : undefined;
	const header = prev !== undefined && !blocks.indented && isHeaderRow(prev, beforePrev);

	if (TABLE_ROW.test(line)) {
		if (header && PARTIAL_DELIMITER_ROW.test(line)) return head + quote + delimiterRow(countCells(prev), line);
		if (prev !== undefined && TABLE_ROW.test(prev)) {
			// A body row waits for content instead of adding an empty row.
			const row = closeRow(line, true);
			return EMPTY_ROW.test(row) ? head : head + quote + row;
		}
		// A header row becomes a table once it has a cell boundary.
		if (pipeCount(line) >= 2) {
			const row = closeRow(line, true);
			return `${head}${quote}${row}\n${quote}${delimiterRow(countCells(row))}`;
		}
	} else if (NON_SPACE.test(line) && !isAmbiguous(line)) {
		const shown = repairParagraph(text, text.length, true, blocks.afterCode);
		// Closing can leave only a block marker, as in `- [`.
		if (!isAmbiguous(splitQuote(shown.slice(shown.lastIndexOf("\n") + 1))[1])) return shown;
	}
	// The last line shows nothing yet; finish the block above it.
	if (header) return head + (quote || prevQuote) + delimiterRow(countCells(prev));
	return head && repairParagraph(head, head.length - 1, false, blocks.afterCode);
}

function scanBlocks(text: string): Blocks {
	const blocks: Blocks = { math: false, listOffset: 0, paragraph: false, indented: false, afterCode: 0 };
	for (let start = 0; start < text.length; ) {
		let end = text.indexOf("\n", start);
		if (end === -1) end = text.length;
		const raw = text.slice(start, end);
		start = end + 1;
		const { fence } = blocks;
		if (fence) {
			// Only the fence's own quote markers are syntax; deeper ones are code.
			const code = insideQuotes(raw, fence.depth);
			if (code !== undefined) {
				const close = FENCE_CLOSE.exec(code);
				if (close && close[1][0] === fence.char && close[1].length >= fence.length) blocks.fence = undefined;
				blocks.afterCode = start;
				continue;
			}
			// The fence ends with its quote.
			blocks.fence = undefined;
		}
		const [quote, line] = splitQuote(raw);
		if (!NON_SPACE.test(line)) {
			blocks.paragraph = false;
			continue;
		}
		blocks.indented = isIndentedCode(line, blocks);
		if (blocks.indented) {
			blocks.afterCode = start;
			continue;
		}
		const open = blocks.math ? null : FENCE_OPEN.exec(line);
		if (open) {
			blocks.fence = { char: open[1][0], length: open[1].length, quote, depth: depthOf(quote) };
			blocks.afterCode = start;
		} else if (line.includes("$$") || line.includes("\\[") || line.includes("\\]")) {
			const plain = line.includes("`") ? line.replace(INLINE_CODE, "") : line;
			DISPLAY_MATH.lastIndex = 0;
			for (let match = DISPLAY_MATH.exec(plain); match; match = DISPLAY_MATH.exec(plain))
				blocks.math = match[0] === "$$" ? !blocks.math : match[0] === "\\[";
		}
		const item = LIST_ITEM.exec(line);
		const indent = indentOf(line);
		const ends = open !== null || BLOCK_END.test(line);
		// A list ends at a less indented line unless it continues the item's paragraph.
		if (item) blocks.listOffset = indent + item[0].trimStart().length;
		else if (indent < blocks.listOffset && (!blocks.paragraph || ends)) blocks.listOffset = indent;
		blocks.paragraph = !ends;
	}
	return blocks;
}

/** Indented code cannot interrupt a paragraph. */
function isIndentedCode(line: string, blocks: Blocks): boolean {
	return !blocks.paragraph && indentOf(line) >= blocks.listOffset + 4;
}

/** Leading whitespace in columns; tabs stop every four. */
function indentOf(line: string): number {
	let columns = 0;
	for (const char of line) {
		if (char === " ") columns++;
		else if (char === "\t") columns += 4 - (columns % 4);
		else break;
	}
	return columns;
}

function isAmbiguous(line: string): boolean {
	return AMBIGUOUS_LINE.test(line.trim());
}

/**
 * Removes markers with nothing after them yet: emphasis, code, escapes, link or image starts,
 * tag names and autolinks. Scans from the end; `$`-anchored patterns would retry every position.
 */
function cutTrailingMarkers(s: string): string {
	let end = s.length;
	for (;;) {
		const before = end;
		// Escaped characters are text; only an unpaired last backslash is cut.
		while (end > 0 && MARKER_CHARS.includes(s[end - 1]) && !isEscaped(s, end - 1)) end--;
		const last = s[end - 1];
		if ((last === "!" || last === "[") && !isEscaped(s, end - 1)) {
			end -= last === "[" && s[end - 2] === "!" && !isEscaped(s, end - 2) ? 2 : 1;
		} else if (end === before) {
			// lastIndexOf clamps a negative start to 0 and would find the same `<` again.
			const tag = end === 0 ? -1 : s.lastIndexOf("<", end - 1);
			const name = tag === -1 ? "" : s.slice(tag + 1, end);
			if (tag === -1 || isEscaped(s, tag) || !(TAG_START.test(name) || AUTOLINK_START.test(name)))
				return s.slice(0, end);
			end = tag;
		}
	}
}

/** Whether an odd run of backslashes precedes `at`. */
function isEscaped(s: string, at: number): boolean {
	let slashes = 0;
	while (s[at - 1 - slashes] === "\\") slashes++;
	return slashes % 2 === 1;
}

/** Separates blockquote markers from line content. */
function splitQuote(line: string): [string, string] {
	const match = QUOTE.exec(line);
	return match ? [match[0], line.slice(match[0].length)] : ["", line];
}

/** Content after `depth` quote markers, or undefined when the quote ended earlier. */
function insideQuotes(line: string, depth: number): string | undefined {
	let rest = line;
	for (let k = 0; k < depth; k++) {
		const marker = QUOTE_MARKER.exec(rest);
		if (!marker) return undefined;
		rest = rest.slice(marker[0].length);
	}
	return rest;
}

function depthOf(quote: string): number {
	return quote.split(">").length - 1;
}

/** Start of the line that ends at `end`. */
function lineStartAt(text: string, end: number): number {
	return end <= 0 ? 0 : text.lastIndexOf("\n", end - 1) + 1;
}

/** Closes inline syntax of the paragraph ending at `end`; it may span several lines from `floor`. */
function repairParagraph(text: string, end: number, atEnd: boolean, floor: number): string {
	// Code ends at `floor`.
	if (end < floor) return text;
	let start = lineStartAt(text, end);
	let [quote, line] = splitQuote(text.slice(start, end));
	while (start > floor && !BLOCK_START.test(line)) {
		const prevStart = lineStartAt(text, start - 1);
		const [prevQuote, prev] = splitQuote(text.slice(prevStart, start - 1));
		// A deeper quote starts a new paragraph; a shallower line continues it lazily.
		if (!NON_SPACE.test(prev) || BLOCK_END.test(prev) || depthOf(quote) > depthOf(prevQuote)) break;
		start = prevStart;
		quote = prevQuote;
		line = prev;
	}
	const region = text.slice(start, end);
	const shown = TABLE_ROW.test(line) ? closeRow(region, atEnd) : closeInline(region, atEnd);
	return text.slice(0, start) + shown + text.slice(end);
}

function isHeaderRow(line: string, before: string | undefined): boolean {
	return (
		TABLE_ROW.test(line) &&
		pipeCount(line) >= 2 &&
		!DELIMITER_ROW.test(line.trim()) &&
		(before === undefined || !TABLE_ROW.test(before))
	);
}

/** Escaped pipes belong to cell content. */
function pipeCount(row: string): number {
	return row.replace(ESCAPED_PIPE, "").split("|").length - 1;
}

function countCells(row: string): number {
	const cells = row.replace(ESCAPED_PIPE, "").trim().split("|");
	if (cells[0] === "") cells.shift();
	if (cells.length > 1 && !NON_SPACE.test(cells[cells.length - 1])) cells.pop();
	return Math.max(cells.length, 1);
}

/** Keeps finished alignment cells of a partial delimiter row. */
function delimiterRow(columns: number, partial = ""): string {
	const cells: string[] = [];
	for (const cell of partial.trim().split("|").slice(1)) {
		const value = cell.trim();
		if (cells.length === columns || !DELIMITER_CELL.test(value)) break;
		cells.push(value);
	}
	while (cells.length < columns) cells.push("---");
	return `| ${cells.join(" | ")} |`;
}

/** Inline syntax cannot span table cells. */
function closeRow(row: string, atEnd: boolean): string {
	let start = row.length;
	while (start > 0 && !(row[start - 1] === "|" && row[start - 2] !== "\\")) start--;
	return row.slice(0, start) + closeInline(row.slice(start), atEnd);
}

/** `atEnd` text may still continue right after its last character. */
function closeInline(text: string, atEnd: boolean): string {
	const s = atEnd ? cutTrailingMarkers(text) : text;
	const open = new Openers();
	let i = 0;
	while (i < s.length) {
		const char = s[i];
		if (char === "\\") {
			const next = s[i + 1];
			if (next === "(" || next === "[") {
				// Unfinished inline math is left untouched.
				const end = s.indexOf(next === "(" ? "\\)" : "\\]", i + 2);
				if (end === -1) return text;
				i = end + 2;
			} else {
				i += 2;
			}
		} else if (char === "$") {
			const delimiter = s[i + 1] === "$" ? "$$" : "$";
			const next = s[i + delimiter.length];
			// `$5` and a lone `$` are currency, not math.
			if (delimiter === "$" && (isSpace(next) || DIGIT.test(next))) {
				i++;
				continue;
			}
			const end = s.indexOf(delimiter, i + delimiter.length);
			if (end === -1) return text;
			i = end + delimiter.length;
		} else if (char === "`") {
			const length = runLength(s, i);
			const end = findCodeRun(s, length, i + length);
			if (end === -1) return finish(s, open, "`".repeat(length));
			i = end + length;
		} else if (char === "*" || char === "_" || char === "~") {
			const length = runLength(s, i);
			// Single tildes are usually "approximately".
			if (char !== "~" || length === 2) {
				const before = s[i - 1];
				const after = s[i + length];
				const canOpen = !isSpace(after) && (isSpace(before) || PUNCTUATION.test(before));
				const canClose = !isSpace(before) && (char !== "_" || isSpace(after) || PUNCTUATION.test(after));
				if (!(canClose && closeRun(open, char, length)) && canOpen) open.push({ char, length, at: i });
			}
			i += length;
		} else if (char === "[") {
			open.push({ char, length: 1, at: i++ });
		} else if (char === "]") {
			const index = open.last("[");
			if (index === -1) {
				i++;
				continue;
			}
			const link = open.items[index];
			// Emphasis does not cross link boundaries.
			open.truncate(index);
			const image = s[link.at - 1] === "!";
			if (s[i + 1] === "(") {
				const end = closingParen(s, i + 2);
				if (end !== -1) {
					i = end + 1;
					continue;
				}
				// The URL is still arriving: show the text as a link, hide images.
				if (image) return finish(s.slice(0, link.at - 1), open);
				return finish(s.slice(0, i + 1), open, `(${INCOMPLETE_LINK_HREF})`);
			}
			if (s[i + 1] === "[") {
				// A reference label, as in `[text][ref]`, is not link text.
				const end = s.indexOf("]", i + 2);
				if (end !== -1) {
					i = end + 1;
					continue;
				}
				if (image) return finish(s.slice(0, link.at - 1), open);
				return finish(s.slice(0, i + 1), open, `(${INCOMPLETE_LINK_HREF})`);
			}
			if (atEnd && i + 1 === s.length) {
				// `[text]` may still get a URL.
				if (image) return finish(s.slice(0, link.at - 1), open);
				if (lastText(s, i) > link.at) return finish(s, open, `(${INCOMPLETE_LINK_HREF})`);
			}
			i++;
		} else {
			i++;
		}
	}
	return finish(s, open);
}

/**
 * Closes openers innermost first, before trailing whitespace (which may be a hard line break).
 * Unfinished images and empty links are removed.
 */
function finish(s: string, open: Openers, suffix = ""): string {
	let end = s.length;
	let textEnd = lastText(s, end);
	let closers = suffix;
	for (let k = open.items.length - 1; k >= 0; k--) {
		const opener = open.items[k];
		if (opener.char !== "[") {
			closers += opener.char.repeat(opener.length);
		} else if (textEnd > opener.at && s[opener.at - 1] !== "!") {
			closers += `](${INCOMPLETE_LINK_HREF})`;
		} else {
			end = s[opener.at - 1] === "!" ? opener.at - 1 : opener.at;
			textEnd = lastText(s, end);
			closers = "";
		}
	}
	const kept = s.slice(0, end);
	if (!closers) return kept;
	const body = textEnd + 1;
	return kept.slice(0, body) + closers + kept.slice(body);
}

/** Index of the last non-space character before `end`, or -1. */
function lastText(s: string, end: number): number {
	let at = end - 1;
	while (at >= 0 && SPACE.test(s[at])) at--;
	return at;
}

function closeRun(open: Openers, char: string, length: number): boolean {
	let remaining = length;
	let closed = false;
	while (remaining > 0) {
		const index = open.last(char);
		if (index === -1) break;
		const opener = open.items[index];
		closed = true;
		if (opener.length > remaining) {
			opener.length -= remaining;
			open.truncate(index + 1);
			break;
		}
		remaining -= opener.length;
		open.truncate(index);
	}
	return closed;
}

/** The start and end of a line count as whitespace. */
function isSpace(char: string | undefined): boolean {
	return char === undefined || SPACE.test(char);
}

/**
 * Stack of unclosed markers. Counts skip searches for absent markers; a successful search
 * drops the entries it passed, so searching stays linear overall.
 */
class Openers {
	readonly items: Opener[] = [];
	private readonly counts: Record<string, number> = { "*": 0, _: 0, "~": 0, "[": 0 };

	push(opener: Opener): void {
		this.items.push(opener);
		this.counts[opener.char]++;
	}

	last(char: string): number {
		if (this.counts[char] === 0) return -1;
		let k = this.items.length - 1;
		while (this.items[k].char !== char) k--;
		return k;
	}

	truncate(length: number): void {
		for (let k = this.items.length - 1; k >= length; k--) this.counts[this.items[k].char]--;
		this.items.length = length;
	}
}

function runLength(s: string, at: number): number {
	let end = at + 1;
	while (s[end] === s[at]) end++;
	return end - at;
}

/** A code span closes with a backtick run of the same length. */
function findCodeRun(s: string, length: number, from: number): number {
	for (let at = s.indexOf("`", from); at !== -1; ) {
		const run = runLength(s, at);
		if (run === length) return at;
		at = s.indexOf("`", at + run);
	}
	return -1;
}

function closingParen(s: string, from: number): number {
	let depth = 1;
	for (let at = from; at < s.length; at++) {
		const char = s[at];
		if (char === "\\") at++;
		else if (char === "(") depth++;
		else if (char === ")" && --depth === 0) return at;
	}
	return -1;
}
