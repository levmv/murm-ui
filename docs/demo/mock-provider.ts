import type { ChatProvider, Message, RequestOptions, StreamEvent } from "../../src/core/types";
import { uuidv7 } from "../../src/utils/uuid";

const RESPONSES = [
	[
		"Hello! I am the local demo provider for Murm UI.",
		"",
		"Try sending a few messages, editing your prompt, attaching a small text file, or copying this response. Everything here runs in the browser, so the demo does not need an API key.",
	].join("\n"),
	[
		"Here is a slightly more structured answer:",
		"",
		"- **Provider**: streams normalized events into the UI.",
		"- **Storage**: saves chat sessions and generated titles.",
		"- **Plugins**: add focused behavior like attachments, copy buttons, and editing.",
		"",
		"The demo rotates canned responses so you can see markdown rendering without calling a model.",
	].join("\n"),
	[
		"A provider can be very small. The important part is emitting stream events:",
		"",
		"```ts",
		"onEvent({",
		'  type: "text_delta",',
		"  messageId,",
		"  blockId,",
		'  delta: "Hello from a provider",',
		"});",
		"```",
		"",
		"Code blocks render without syntax highlighting in this static demo, which keeps the page light.",
	].join("\n"),
	[
		"One more thing to poke at: Murm UI keeps the UI pieces separate from provider logic.",
		"",
		"That means you can start with a local mock, switch to an OpenAI-compatible endpoint later, and keep the same chat shell.",
	].join("\n"),
];

export class MockProvider implements ChatProvider {
	async streamChat(
		messages: Message[],
		_options: RequestOptions,
		signal: AbortSignal,
		onEvent: (event: StreamEvent) => void,
	): Promise<void> {
		return new Promise((resolve) => {
			const messageId = uuidv7();
			const blockId = uuidv7();

			onEvent({
				type: "message_start",
				message: { id: messageId, role: "assistant", blocks: [] },
			});

			const responseIndex = messages.filter((message) => message.role === "user").length - 1;
			const chunks = splitIntoChunks(RESPONSES[Math.max(0, responseIndex) % RESPONSES.length]);
			let index = 0;

			const interval = setInterval(() => {
				if (signal.aborted) {
					clearInterval(interval);
					onEvent({ type: "finish", reason: "aborted" });
					resolve();
					return;
				}

				if (index < chunks.length) {
					onEvent({
						type: "text_delta",
						messageId,
						blockId,
						delta: chunks[index],
					});
					index++;
				} else {
					clearInterval(interval);
					onEvent({ type: "finish", reason: "stop" });
					resolve();
				}
			}, 50);
		});
	}

	async generateTitle(_messages: Message[], _options?: RequestOptions, _signal?: AbortSignal): Promise<string> {
		return new Promise((resolve) => setTimeout(() => resolve("Simulated Chat"), 600));
	}
}

function splitIntoChunks(text: string): string[] {
	return text.match(/(\S+\s*)/g) ?? [text];
}
