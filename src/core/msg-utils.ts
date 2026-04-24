import type { Message } from "./types";

/** Checks if the message has standard or encrypted reasoning */
export function hasReasoning(msg: Message): boolean {
	return msg.blocks.some((b) => b.type === "reasoning");
}

/**
 * Returns the combined reasoning text, or a safe fallback for encrypted content
 */
export function getDisplayReasoning(msg: Message): string {
	let text = "";
	let hasEncrypted = false;

	for (const block of msg.blocks) {
		if (block.type === "reasoning") {
			if (block.text) text += block.text;
			if (block.encrypted) hasEncrypted = true;
		}
	}

	if (!text && hasEncrypted) {
		return "<i>Thought process is hidden by the model provider.</i>";
	}
	return text;
}

/** Extracts all plain text from text blocks */
export function extractPlainText(msg: Message): string {
	return msg.blocks
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n\n");
}
