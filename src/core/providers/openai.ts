import { parseSSE } from "../../utils/sse";
import { uuidv7 } from "../../utils/uuid";
import type { ChatProvider, FinishReason, Message, RequestOptions, StreamEvent } from "../types";

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
		prompt_tokens_details?: {
			cached_tokens?: number;
		};
	};
}

type OpenAIContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"] as const;

export class OpenAIProvider implements ChatProvider {
	constructor(
		private apiKey: string,
		private endpoint: string,
		private model: string,
	) {}

	async streamChat(
		messages: Message[],
		options: RequestOptions,
		signal: AbortSignal,
		onEvent: (event: StreamEvent) => void,
	): Promise<void> {
		try {
			const { model = this.model, systemPrompt, ...restOptions } = options;

			const response = await fetch(this.endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify({
					model: model,
					messages: this.formatMessages(messages),
					stream: true,
					...restOptions,
					stream_options: {
						include_usage: true,
						...((restOptions.stream_options as object) || {}),
					},
				}),
				signal,
			});

			if (!response.ok) {
				const errorMsg = await this.extractErrorMessage(response);
				throw new Error(`API Error ${response.status}: ${errorMsg}`);
			}

			let messageStarted = false;
			let currentMessageId = uuidv7();
			let currentTextBlockId: string | null = null;
			let currentReasoningBlockId: string | null = null;

			// Map OpenAI's tool call index to our block IDs
			const activeToolCalls = new Map<number, string>();

			let finishEmitted = false;

			await parseSSE(response, (data) => {
				if (data === "[DONE]") return true;

				// Flat try/catch: Just parse and exit early if it's a broken chunk
				let parsed: OpenAIStreamChunk;
				try {
					parsed = JSON.parse(data);
				} catch {
					return; // Ignore partial/broken JSON payload
				}
				if (parsed.usage) {
					onEvent({
						type: "usage",
						input: parsed.usage.prompt_tokens || 0,
						output: parsed.usage.completion_tokens || 0,
						cacheRead: parsed.usage.prompt_tokens_details?.cached_tokens || 0,
					});
				}

				const choice = parsed.choices?.[0];
				if (!choice) return;

				// 1. Emit start event on first chunk
				if (!messageStarted) {
					currentMessageId = parsed.id || currentMessageId;
					onEvent({
						type: "message_start",
						message: { id: currentMessageId, role: "assistant", blocks: [] },
					});
					messageStarted = true;
				}

				const delta: OpenAIStreamDelta = choice.delta ?? {};

				// 2. Handle Reasoning
				const reasoningData = this.extractReasoning(delta);
				if (reasoningData) {
					if (!currentReasoningBlockId) currentReasoningBlockId = uuidv7();
					currentTextBlockId = null;

					onEvent({
						type: "reasoning_delta",
						messageId: currentMessageId,
						blockId: currentReasoningBlockId,
						delta: reasoningData.text,
						encrypted: reasoningData.encrypted,
					});
				}

				// 3. Handle Text Content
				if (delta.content) {
					if (!currentTextBlockId) currentTextBlockId = uuidv7();
					onEvent({
						type: "text_delta",
						messageId: currentMessageId,
						blockId: currentTextBlockId,
						delta: delta.content,
					});
				}

				// 4. Handle Tool Calls
				if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
					for (const tc of delta.tool_calls) {
						const index = tc.index;
						// If it has an ID, it's a new tool call
						if (tc.id) {
							currentTextBlockId = null;

							const blockId = uuidv7();
							activeToolCalls.set(index, blockId);
							onEvent({
								type: "tool_call_start",
								messageId: currentMessageId,
								block: {
									id: blockId,
									type: "tool_call",
									toolCallId: tc.id,
									name: tc.function?.name || "",
									argsText: tc.function?.arguments || "",
									status: "streaming",
								},
							});
						}
						// Otherwise, it's appending arguments to an existing tool call
						else if (activeToolCalls.has(index)) {
							onEvent({
								type: "tool_call_delta",
								messageId: currentMessageId,
								blockId: activeToolCalls.get(index)!,
								argsDelta: tc.function?.arguments || "",
							});
						}
					}
				}

				// 5. Handle Finish Reason
				if (choice.finish_reason) {
					if (choice.finish_reason === "content_filter") {
						throw new Error("Generation stopped by provider content filter.");
					}
					if (choice.finish_reason === "network_error") {
						throw new Error("Generation stopped due to a provider network error.");
					}

					const reasonMap: Record<string, FinishReason> = {
						stop: "stop",
						length: "length",
						tool_calls: "tool_use",
					};
					onEvent({
						type: "finish",
						reason: reasonMap[choice.finish_reason] || "stop",
					});
					finishEmitted = true;
				}
			});

			// If it finishes normally but didn't emit a finish reason (some providers do this)
			if (!finishEmitted) {
				onEvent({ type: "finish", reason: "stop" });
			}
		} catch (err: unknown) {
			const isAbort = err instanceof Error && err.name === "AbortError";
			if (isAbort || signal.aborted) {
				onEvent({ type: "finish", reason: "aborted" });
			} else {
				// Safer fallback stringification for unknown thrown objects
				const errorMessage = err instanceof Error ? err.message : JSON.stringify(err);
				onEvent({ type: "error", message: errorMessage });
			}
		}
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

	async generateTitle(messages: Message[], options?: RequestOptions, signal?: AbortSignal): Promise<string> {
		try {
			let endIndex = messages.findIndex((m) => m.role === "assistant" && m.blocks.length > 0);
			if (endIndex === -1) endIndex = Math.min(messages.length - 1, 3);

			const contextMessages = messages.slice(0, endIndex + 1);

			const response = await fetch(this.endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify({
					model: options?.model || this.model,
					messages: [
						...this.formatMessages(contextMessages),
						{
							role: "user",
							content:
								"Summarize the above conversation in 3-5 words. Reply ONLY with the title, no quotes, no extra text.",
						},
					],
					stream: false,
				}),
				signal,
			});

			if (!response.ok) return "";
			const data = await response.json();
			return data.choices[0]?.message?.content?.trim() || "";
		} catch (error) {
			const isAbort = error instanceof Error && error.name === "AbortError";
			if (!isAbort && !signal?.aborted) {
				console.warn("Failed to generate chat title.", error);
			}
			return "";
		}
	}

	private formatMessages(messages: Message[]): Record<string, unknown>[] {
		const result: Record<string, unknown>[] = [];

		for (const msg of messages) {
			// Tool messages map 1:1 to API tool responses.
			// They contain only the execution output, so we bypass standard processing.
			if (msg.role === "tool") {
				for (const block of msg.blocks) {
					if (block.type === "tool_result") {
						result.push({
							role: "tool",
							tool_call_id: block.toolCallId,
							content: block.outputText,
						});
					}
				}
				continue;
			}

			const payload: Record<string, unknown> = { role: msg.role };
			const toolCalls: Record<string, unknown>[] = [];
			const contentArray: OpenAIContentPart[] = [];

			for (const block of msg.blocks) {
				switch (block.type) {
					case "tool_call":
						toolCalls.push({
							id: block.toolCallId,
							type: "function",
							function: { name: block.name, arguments: block.argsText },
						});
						break;

					case "text":
						contentArray.push({ type: "text", text: block.text });
						break;

					case "file":
						if (block.mimeType.startsWith("image/")) {
							contentArray.push({ type: "image_url", image_url: { url: block.data } });
						} else {
							contentArray.push({
								type: "text",
								text: `\n\n--- File: ${block.name || "Unknown"} ---\n${block.data}`,
							});
						}
						break;

					case "reasoning":
					case "artifact":
						// Intentionally omitted.
						// Reasoning tokens and internal UI artifacts are not sent back in context.
						break;
				}
			}

			if (toolCalls.length > 0) {
				payload.tool_calls = toolCalls;
			}
			// Conform to OpenAI's expected content structures
			if (msg.role === "assistant") {
				// Assistant messages strictly require a string or null (never an array)
				if (contentArray.length === 0) {
					payload.content = toolCalls.length > 0 ? null : "";
				} else {
					// Safely flatten any multiple text blocks into a single string
					payload.content = contentArray
						.filter((c) => c.type === "text")
						.map((c) => (c as { text: string }).text)
						.join("\n\n");
				}
			} else {
				// User messages can safely use the multimodal array format
				if (contentArray.length === 0) {
					payload.content = toolCalls.length > 0 ? null : "";
				} else if (contentArray.length === 1 && contentArray[0].type === "text") {
					// Fast path for simple text messages
					payload.content = contentArray[0].text;
				} else {
					// Multimodal or multi-part message
					payload.content = contentArray;
				}
			}

			result.push(payload);
		}
		return result;
	}

	private extractReasoning(delta: OpenAIStreamDelta): { text: string; encrypted: boolean } | null {
		// Check for encrypted reasoning (e.g., Anthropic via OpenRouter / Some DeepSeek setups)
		if (delta.reasoning && typeof delta.reasoning === "object" && typeof delta.reasoning.encrypted === "string") {
			return { text: delta.reasoning.encrypted, encrypted: true };
		}
		if (typeof delta.reasoning_encrypted === "string") {
			return { text: delta.reasoning_encrypted, encrypted: true };
		}

		// Check for standard reasoning
		for (const field of REASONING_FIELDS) {
			if (typeof delta[field] === "string" && delta[field].length > 0) {
				return { text: delta[field], encrypted: false };
			}
		}

		return null;
	}
}
