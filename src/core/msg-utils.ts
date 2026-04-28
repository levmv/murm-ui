import type { Message } from "./types";

/** Extracts all plain text from text blocks */
export function extractPlainText(msg: Message): string {
	return msg.blocks
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n\n");
}
