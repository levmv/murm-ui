import { parseSSE } from "../../utils/sse";
import { uuidv7 } from "../../utils/uuid";
import type { ConversationChange } from "../conversation-types";
import type { ChatProvider, ChatRequest, ChatStreamRequest, Message } from "../types";

type OpenAIStreamDelta = {
	content?: string | null;
	tool_calls?: Array<{
		index: number;
		id?: string;
		type?: string;
		function?: {
			name?: string;
			arguments?: string;
		};
	}>;
	reasoning?: string | { encrypted?: string };
	reasoning_encrypted?: string;
	reasoning_content?: string;
	reasoning_text?: string;
	[key: string]: unknown;
};

interface OpenAIStreamChunk {
	id?: string;
	choices?: Array<{
		delta?: OpenAIStreamDelta;
		finish_reason?: string;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		prompt_tokens_details?: {
			cached_tokens?: number;
		};
	};
}

type OpenAIContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"] as const;
const DEFAULT_TITLE_SYSTEM_PROMPT =
	"You generate concise chat titles. Reply only with the title, without quotes or extra text.";

export class OpenAIProvider implements ChatProvider {
	constructor(
		private apiKey: string,
		private endpoint: string,
		private model: string,
	) {}

	async streamChat(request: ChatStreamRequest, onChange: (changes: ConversationChange[]) => void): Promise<void> {
		const { model = this.model, ...restOptions } = request.options;

		const response = await fetch(this.endpoint, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({
				...restOptions,
				model,
				messages: this.formatMessagesWithInstructions(request.messages, request.instructions),
				stream: true,
				...(request.tools ? { tools: request.tools } : {}),
				stream_options: {
					include_usage: true,
					...((restOptions.stream_options as object) || {}),
				},
			}),
			signal: request.signal,
		});

		if (!response.ok) {
			const errorMessage = await this.extractErrorMessage(response);
			throw new Error(`API Error ${response.status}: ${errorMessage}`);
		}

		const { messageId } = request;
		let textBlockId: string | undefined;
		let reasoningBlockId: string | undefined;
		const toolBlockIds = new Map<number, string>();

		await parseSSE(response, (data) => {
			if (data === "[DONE]") return true;
			let parsed: OpenAIStreamChunk;
			try {
				parsed = JSON.parse(data);
			} catch {
				return;
			}
			const changes: ConversationChange[] = [];
			if (parsed.usage) {
				const input = parsed.usage.prompt_tokens ?? 0;
				const output = parsed.usage.completion_tokens ?? 0;
				changes.push({
					type: "message.state",
					messageId,
					usage: {
						input,
						output,
						total: parsed.usage.total_tokens ?? input + output,
						cacheRead: parsed.usage.prompt_tokens_details?.cached_tokens ?? 0,
					},
				});
			}
			const choice = parsed.choices?.[0];
			const delta = choice?.delta ?? {};
			const reasoning = this.extractReasoning(delta);
			if (reasoning) {
				textBlockId = undefined;
				if (!reasoningBlockId) {
					reasoningBlockId = uuidv7();
					changes.push({
						type: "block.put",
						messageId,
						block: {
							id: reasoningBlockId,
							type: "reasoning",
							text: reasoning.encrypted ? "" : reasoning.text,
							...(reasoning.encrypted ? { encrypted: true } : {}),
						},
					});
				} else
					changes.push({
						type: "text.append",
						messageId,
						blockId: reasoningBlockId,
						delta: reasoning.text,
						encrypted: reasoning.encrypted,
					});
			}
			if (delta.content) {
				reasoningBlockId = undefined;
				if (!textBlockId) {
					textBlockId = uuidv7();
					changes.push({ type: "block.put", messageId, block: { id: textBlockId, type: "text", text: delta.content } });
				} else changes.push({ type: "text.append", messageId, blockId: textBlockId, delta: delta.content });
			}
			for (const call of delta.tool_calls ?? []) {
				if (call.id) {
					textBlockId = undefined;
					reasoningBlockId = undefined;
					const id = uuidv7();
					toolBlockIds.set(call.index, id);
					changes.push({
						type: "block.put",
						messageId,
						block: {
							id,
							type: "tool_call",
							toolCallId: call.id,
							name: call.function?.name ?? "",
							argsText: call.function?.arguments ?? "",
							status: "streaming",
						},
					});
				} else {
					const blockId = toolBlockIds.get(call.index);
					if (blockId)
						changes.push({
							type: "tool.update",
							messageId,
							blockId,
							name: call.function?.name,
							argsDelta: call.function?.arguments,
						});
				}
			}
			if (changes.length) onChange(changes);
			if (choice?.finish_reason === "content_filter") throw new Error("Generation stopped by provider content filter.");
			if (choice?.finish_reason === "network_error")
				throw new Error("Generation stopped due to a provider network error.");
			return undefined;
		});
		const completionChanges: ConversationChange[] = Array.from(toolBlockIds.values(), (blockId) => ({
			type: "tool.update",
			messageId,
			blockId,
			status: "complete",
		}));
		completionChanges.push({ type: "message.state", messageId, status: "complete", updatedAt: Date.now() });
		onChange(completionChanges);
	}

	private async extractErrorMessage(response: Response): Promise<string> {
		const text = await response.text();
		try {
			const parsed = JSON.parse(text);
			return parsed.error?.message || parsed.message || parsed.error?.metadata?.raw || text;
		} catch {
			return text;
		}
	}

	async generateTitle(request: ChatRequest): Promise<string> {
		try {
			const { model = this.model, stream_options: _streamOptions, ...restOptions } = request.options;
			const titleSystemPrompt =
				typeof request.instructions === "string" && request.instructions.trim().length > 0
					? request.instructions
					: DEFAULT_TITLE_SYSTEM_PROMPT;

			let endIndex = request.messages.findIndex((m) => m.role === "assistant" && m.blocks.length > 0);
			if (endIndex === -1) endIndex = Math.min(request.messages.length - 1, 3);

			const contextMessages = request.messages.slice(0, endIndex + 1);
			const formattedMessages = [
				{ role: "system", content: titleSystemPrompt },
				...this.formatMessages(contextMessages),
				{
					role: "user",
					content:
						"Summarize the above conversation in 3-5 words. Reply ONLY with the title, no quotes, no extra text.",
				},
			];

			const response = await fetch(this.endpoint, {
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify({
					...restOptions,
					model,
					messages: formattedMessages,
					stream: false,
				}),
				signal: request.signal,
			});

			if (!response.ok) return "";
			const data = await response.json();
			return this.normalizeTitle(data.choices[0]?.message?.content);
		} catch (error) {
			const isAbort = error instanceof Error && error.name === "AbortError";
			if (!isAbort && !request.signal.aborted) {
				console.warn("Failed to generate chat title.", error);
			}
			return "";
		}
	}

	private normalizeTitle(title: unknown): string {
		if (typeof title !== "string") return "";

		const normalized = title.replace(/\s+/g, " ").trim();
		const unquoted = normalized.replace(/^['"]+|['"]+$/g, "").trim();

		if (unquoted.length <= 80) return unquoted;
		return `${unquoted.slice(0, 77).trimEnd()}...`;
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		const apiKey = this.apiKey.trim();
		if (apiKey) {
			headers.Authorization = `Bearer ${apiKey}`;
		}
		return headers;
	}

	private formatMessages(messages: Message[]): Record<string, unknown>[] {
		const result: Record<string, unknown>[] = [];
		const serializedToolCallIds = new Set<string>();

		for (const message of messages) {
			// Include results only for tool calls already serialized into this request.
			if (message.role === "tool") {
				for (const block of message.blocks) {
					if (block.type === "tool_result" && serializedToolCallIds.has(block.toolCallId)) {
						result.push({
							role: "tool",
							tool_call_id: block.toolCallId,
							content: block.outputText,
						});
					}
				}
				continue;
			}

			const payload: Record<string, unknown> = { role: message.role };
			const toolCalls: Record<string, unknown>[] = [];
			const contentParts: OpenAIContentPart[] = [];

			for (const block of message.blocks) {
				switch (block.type) {
					case "tool_call":
						if (block.status === "complete") {
							toolCalls.push({
								id: block.toolCallId,
								type: "function",
								function: { name: block.name, arguments: block.argsText },
							});
							serializedToolCallIds.add(block.toolCallId);
						}
						break;

					case "text":
						contentParts.push({ type: "text", text: block.text });
						break;

					case "file":
						if (block.mimeType.startsWith("image/")) {
							contentParts.push({ type: "image_url", image_url: { url: block.data } });
						} else {
							contentParts.push({
								type: "text",
								text: `\n\n--- File: ${block.name || "Unknown"} ---\n${block.data}`,
							});
						}
						break;

					case "reasoning":
					case "artifact":
					case "custom":
						// Display-only blocks are excluded from provider context.
						break;
				}
			}

			if (message.role === "assistant" && contentParts.length === 0 && toolCalls.length === 0) {
				continue;
			}

			if (toolCalls.length > 0) {
				payload.tool_calls = toolCalls;
			}
			if (message.role === "assistant") {
				// Send assistant text as a single string, or null for tool-only messages.
				if (contentParts.length === 0) {
					payload.content = toolCalls.length > 0 ? null : "";
				} else {
					payload.content = contentParts
						.filter((c) => c.type === "text")
						.map((c) => (c as { text: string }).text)
						.join("\n\n");
				}
			} else {
				if (contentParts.length === 0) {
					payload.content = toolCalls.length > 0 ? null : "";
				} else if (contentParts.length === 1 && contentParts[0].type === "text") {
					payload.content = contentParts[0].text;
				} else {
					payload.content = contentParts;
				}
			}

			result.push(payload);
		}
		return result;
	}

	private formatMessagesWithInstructions(messages: Message[], instructions?: string): Record<string, unknown>[] {
		const formattedMessages = this.formatMessages(messages);
		if (!instructions) return formattedMessages;
		return [{ role: "system", content: instructions }, ...formattedMessages];
	}

	private extractReasoning(delta: OpenAIStreamDelta): { text: string; encrypted: boolean } | null {
		// Keep the hidden-reasoning marker without retaining encrypted payloads.
		if (delta.reasoning && typeof delta.reasoning === "object" && typeof delta.reasoning.encrypted === "string") {
			return { text: "", encrypted: true };
		}
		if (typeof delta.reasoning_encrypted === "string") {
			return { text: "", encrypted: true };
		}

		for (const field of REASONING_FIELDS) {
			if (typeof delta[field] === "string" && delta[field].length > 0) {
				return { text: delta[field], encrypted: false };
			}
		}

		return null;
	}
}
