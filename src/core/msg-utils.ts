import type { ContentBlock, JsonValue, Message, TokenUsage } from "./types";

/** Joins text blocks in message order, separated by blank lines. */
export function extractPlainText(msg: Message): string {
	return msg.blocks
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n\n");
}

export function dropEphemeralMessages(messages: Message[]): Message[] {
	return messages.filter((m) => !m.ephemeral);
}

export function cloneMessages(messages: Message[]): Message[] {
	return messages.map(cloneMessage);
}

export function cloneMessage(message: Message): Message {
	const cloned: Message = { ...message, blocks: message.blocks.map(cloneBlock) };
	if (message.usage) cloned.usage = cloneUsage(message.usage);
	if (message.meta) cloned.meta = cloneJsonValue(message.meta);
	return cloned;
}

export function cloneBlock(block: ContentBlock): ContentBlock {
	return block.type === "custom" ? { ...block, data: cloneJsonValue(block.data) } : { ...block };
}

export function cloneUsage(usage: TokenUsage): TokenUsage {
	return {
		...usage,
		...(usage.details !== undefined ? { details: cloneJsonValue(usage.details) } : {}),
	};
}

export function cloneJsonValue<T extends JsonValue>(value: T): T {
	if (Array.isArray(value)) {
		return value.map((item) => cloneJsonValue(item)) as T;
	}
	if (value && typeof value === "object") {
		// Copy own properties first so a JSON key named "__proto__" remains data.
		const cloned = { ...value } as { [key: string]: JsonValue };
		for (const [key, item] of Object.entries(value)) {
			cloned[key] = cloneJsonValue(item);
		}
		return cloned as T;
	}
	return value;
}
