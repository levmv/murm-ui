import type {
	ConversationChange,
	ConversationInvalidation,
	ConversationSnapshot,
	ConversationState,
	ConversationUpdate,
} from "./conversation-types";
import { cloneBlock, cloneMessage, cloneMessages, cloneUsage } from "./msg-utils";
import type { ContentBlock, Message } from "./types";

/** Owns the loaded conversation. No provider, storage, fetch, or DOM dependencies. */
export class ConversationModel {
	private current: ConversationState = {
		id: "",
		messages: [],
	};
	readonly streamingMessageIds = new Set<string>();
	private messagesById = new Map<string, Message>();
	private visibleText = new WeakSet<ContentBlock>();
	private listeners = new Set<(change: ConversationInvalidation) => void>();

	/** Stable during updates; a snapshot replaces this object. */
	get state(): ConversationState {
		return this.current;
	}

	getMessage(id: string): Message | undefined {
		return this.messagesById.get(id);
	}

	getBlock(messageId: string, blockId: string): ContentBlock | undefined {
		const message = this.messagesById.get(messageId);
		return message && findBlock(message, blockId);
	}

	subscribe(listener: (change: ConversationInvalidation) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	setConversation(snapshot: ConversationSnapshot): void {
		if (!snapshot.id) throw new Error("A conversation needs a non-empty id");
		validateMessages(snapshot.messages);
		this.current = {
			id: snapshot.id,
			messages: cloneMessages(snapshot.messages),
		};
		this.reindex();
		this.notify({ messageIds: new Set(), structural: true, reset: true });
	}

	apply(update: ConversationUpdate): boolean {
		if (!this.state.id || update.conversationId !== this.state.id) return false;
		// Validate addresses against a lightweight projection first. An invalid
		// batch cannot apply a prefix and leave the displayed state half updated.
		this.validate(update.changes);
		const invalidation: ConversationInvalidation = { messageIds: new Set(), structural: false };
		for (const change of update.changes) {
			switch (change.type) {
				case "message.put": {
					const message = cloneMessage(change.message);
					const previous = this.messagesById.get(message.id);
					const index = previous ? this.state.messages.indexOf(previous) : -1;
					if (index >= 0) this.state.messages.splice(index, 1);
					const position =
						change.beforeId === undefined
							? index < 0
								? this.state.messages.length
								: index
							: this.state.messages.findIndex((item) => item.id === change.beforeId);
					this.state.messages.splice(position, 0, message);
					this.indexMessage(message);
					invalidation.structural = true;
					break;
				}
				case "message.remove": {
					const message = this.messagesById.get(change.messageId);
					if (!message) break;
					this.state.messages.splice(this.state.messages.indexOf(message), 1);
					this.messagesById.delete(message.id);
					this.streamingMessageIds.delete(message.id);
					invalidation.structural = true;
					break;
				}
				case "message.state": {
					const message = this.messagesById.get(change.messageId)!;
					if (change.status !== undefined) {
						invalidation.structural ||= message.status !== change.status;
						message.status = change.status;
						this.syncStreaming(message);
					}
					if (change.status !== undefined || change.error !== undefined) {
						invalidation.structural ||= message.error !== change.error;
						message.error = change.error;
					}
					if (change.usage) message.usage = cloneUsage(change.usage);
					touch(message, change.updatedAt);
					invalidation.messageIds.add(message.id);
					break;
				}
				case "block.put": {
					const message = this.messagesById.get(change.messageId)!;
					const block = cloneBlock(change.block);
					if (
						message.ephemeral &&
						((block.type !== "text" && block.type !== "reasoning") ||
							(block.type === "text" && block.text) ||
							(block.type === "reasoning" && (block.text || block.encryptedText)))
					)
						delete message.ephemeral;
					touch(message, change.updatedAt);
					const index = message.blocks.findIndex((item) => item.id === block.id);
					const previous = message.blocks[index];
					if (
						previous?.type === block.type &&
						block.type !== "text" &&
						block.type !== "reasoning" &&
						block.type !== "tool_result"
					) {
						// These block types cannot change grouping. Keep their identity in
						// cached projections, but remove omitted optional fields on replacement.
						for (const key of Object.keys(previous)) {
							if (!Object.hasOwn(block, key)) Reflect.deleteProperty(previous, key);
						}
						Object.assign(previous, block);
						invalidation.messageIds.add(message.id);
					} else {
						if (index < 0) message.blocks.push(block);
						else message.blocks[index] = block;
						this.indexText(block);
						// Tool results also refresh calls in other messages and their caches.
						invalidation.structural = true;
					}
					break;
				}
				case "block.remove": {
					const message = this.messagesById.get(change.messageId)!;
					const index = message.blocks.findIndex((block) => block.id === change.blockId);
					if (index < 0) break;
					message.blocks.splice(index, 1);
					invalidation.structural = true;
					break;
				}
				case "text.append": {
					if (!change.delta) break;
					const message = this.messagesById.get(change.messageId)!;
					const block = findBlock(message, change.blockId)!;
					if (block.type !== "text" && block.type !== "reasoning") break;
					// Only an empty-to-visible transition can change run grouping.
					if (block.type === "reasoning" && change.encrypted) {
						block.encrypted = true;
						block.encryptedText = (block.encryptedText ?? "") + change.delta;
					} else block.text += change.delta;
					if (message.ephemeral) delete message.ephemeral;
					touch(message, change.updatedAt);
					if (!change.encrypted && !this.visibleText.has(block) && change.delta.trim()) {
						this.visibleText.add(block);
						invalidation.structural = true;
					}
					invalidation.messageIds.add(message.id);
					break;
				}
				case "tool.update": {
					if (change.name === undefined && !change.argsDelta && !change.status) break;
					const message = this.messagesById.get(change.messageId)!;
					const block = findBlock(message, change.blockId)!;
					if (block.type !== "tool_call") break;
					if (change.name !== undefined) block.name = change.name;
					if (change.argsDelta) block.argsText += change.argsDelta;
					if (change.status) block.status = change.status;
					if (message.ephemeral) delete message.ephemeral;
					touch(message, change.updatedAt);
					invalidation.messageIds.add(message.id);
					break;
				}
			}
		}
		if (invalidation.structural) {
			// Structural revisions also invalidate plugins' transcript caches. Token
			// appends keep this array and every unaffected message/block in place.
			this.state.messages = [...this.state.messages];
		}
		if (invalidation.structural || invalidation.messageIds.size) this.notify(invalidation);
		return true;
	}

	prepend(conversationId: string, messages: Message[]): boolean {
		if (!this.state.id || conversationId !== this.state.id) return false;
		validateMessages(messages);
		// A history request may race with live updates: overlapping older copies
		// must never roll back the current version of an existing message.
		const older = cloneMessages(messages.filter((message) => !this.messagesById.has(message.id)));
		if (older.length) {
			this.state.messages = [...older, ...this.state.messages];
			for (const message of older) this.indexMessage(message);
			this.notify({ messageIds: new Set(), structural: true });
		}
		return true;
	}

	private reindex(): void {
		this.messagesById.clear();
		this.streamingMessageIds.clear();
		this.visibleText = new WeakSet();
		for (const message of this.state.messages) this.indexMessage(message);
	}

	private indexMessage(message: Message): void {
		this.messagesById.set(message.id, message);
		this.syncStreaming(message);
		for (const block of message.blocks) this.indexText(block);
	}

	private syncStreaming(message: Message): void {
		if (message.status === "streaming") this.streamingMessageIds.add(message.id);
		else this.streamingMessageIds.delete(message.id);
	}

	private indexText(block: ContentBlock): void {
		if ((block.type === "text" || block.type === "reasoning") && block.text.trim()) this.visibleText.add(block);
	}

	private validate(changes: ConversationChange[]): void {
		// Token and metadata updates cannot change addresses, so validate them
		// directly without building a speculative index of every block.
		if (
			changes.every(
				(change) => change.type === "text.append" || change.type === "tool.update" || change.type === "message.state",
			)
		) {
			for (const change of changes) {
				const message = this.messagesById.get(change.messageId);
				if (!message) throw new Error(`Unknown message: ${change.messageId}`);
				if (change.type !== "message.state") validateDelta(change, findBlock(message, change.blockId)?.type);
			}
			return;
		}
		const shapes = new Map<string, Map<string, ContentBlock["type"]> | null>();
		const get = (id: string) => {
			if (!shapes.has(id)) {
				const message = this.messagesById.get(id);
				shapes.set(id, message ? new Map(message.blocks.map((block) => [block.id, block.type])) : null);
			}
			return shapes.get(id);
		};
		for (const change of changes) {
			if (change.type === "message.put") {
				validateMessages([change.message]);
				if (change.beforeId !== undefined && (change.beforeId === change.message.id || !get(change.beforeId))) {
					throw new Error(`Invalid message position: ${change.beforeId}`);
				}
				shapes.set(change.message.id, new Map(change.message.blocks.map((block) => [block.id, block.type])));
			} else if (change.type === "message.remove") {
				shapes.set(change.messageId, null);
			} else if ("messageId" in change) {
				const blocks = get(change.messageId);
				if (!blocks) throw new Error(`Unknown message: ${change.messageId}`);
				if (change.type === "block.put") {
					if (!change.block.id) throw new Error("A block needs a non-empty id");
					blocks.set(change.block.id, change.block.type);
				} else if (change.type === "block.remove") {
					blocks.delete(change.blockId);
				} else if (change.type === "text.append" || change.type === "tool.update") {
					validateDelta(change, blocks.get(change.blockId));
				}
			}
		}
	}

	private notify(change: ConversationInvalidation): void {
		for (const listener of this.listeners) listener(change);
	}
}

function touch(message: Message, updatedAt?: number): void {
	if (updatedAt === undefined) return;
	message.createdAt ??= updatedAt;
	message.updatedAt = updatedAt;
}

function validateDelta(
	change: Extract<ConversationChange, { type: "text.append" | "tool.update" }>,
	type?: ContentBlock["type"],
): void {
	const valid =
		change.type === "tool.update"
			? type === "tool_call"
			: change.encrypted
				? type === "reasoning"
				: type === "text" || type === "reasoning";
	if (!valid) throw new Error(`Invalid append target: ${change.messageId}/${change.blockId}`);
}

function findBlock(message: Message, blockId: string): ContentBlock | undefined {
	const last = message.blocks[message.blocks.length - 1];
	return last?.id === blockId ? last : message.blocks.find((block) => block.id === blockId);
}

function validateMessages(messages: readonly Message[]): void {
	const ids = new Set<string>();
	for (const message of messages) {
		if (!message.id || ids.has(message.id)) throw new Error(`Duplicate or empty message id: ${message.id}`);
		ids.add(message.id);
		const blocks = new Set<string>();
		for (const block of message.blocks) {
			if (!block.id || blocks.has(block.id)) throw new Error(`Duplicate or empty block id: ${message.id}/${block.id}`);
			blocks.add(block.id);
		}
	}
}
