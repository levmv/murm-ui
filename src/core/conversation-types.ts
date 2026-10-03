import type { ContentBlock, Message, TokenUsage } from "./types";

export interface ConversationSnapshot {
	id: string;
	messages: Message[];
}

export type ConversationState = ConversationSnapshot;

export type ConversationChange =
	| { type: "message.put"; message: Message; beforeId?: string }
	| { type: "message.remove"; messageId: string }
	| {
			type: "message.state";
			messageId: string;
			status?: NonNullable<Message["status"]>;
			error?: string;
			usage?: TokenUsage;
			updatedAt?: number;
	  }
	| { type: "block.put"; messageId: string; block: ContentBlock; updatedAt?: number }
	| { type: "block.remove"; messageId: string; blockId: string }
	| { type: "text.append"; messageId: string; blockId: string; delta: string; encrypted?: boolean; updatedAt?: number }
	| {
			type: "tool.update";
			messageId: string;
			blockId: string;
			argsDelta?: string;
			name?: string;
			status?: Extract<ContentBlock, { type: "tool_call" }>["status"];
			updatedAt?: number;
	  };

/** Delivery, deduplication and ordering of network events belong to the caller. */
export interface ConversationUpdate {
	conversationId: string;
	changes: ConversationChange[];
}

export interface ConversationInvalidation {
	messageIds: Set<string>;
	structural: boolean;
	/** A snapshot replaced the conversation, including a reload of the same id. */
	reset?: boolean;
}
