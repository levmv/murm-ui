import type { Message } from "./types";

/** Extracts all plain text from text blocks */
export function extractPlainText(msg: Message): string {
	return msg.blocks
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n\n");
}

export function dropEphemeralMessages(messages: Message[]): Message[] {
	return messages.filter((m) => !m.meta?.ephemeral);
}

export function cloneMessages(messages: Message[]): Message[] {
	return messages.map((message) => {
		const cloned: Message = {
			...message,
			blocks: message.blocks.map((block) => ({ ...block })),
		};
		if (message.meta) {
			cloned.meta = { ...message.meta };
		}
		return cloned;
	});
}
