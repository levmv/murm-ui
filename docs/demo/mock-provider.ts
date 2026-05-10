import type { ChatProvider, ChatRequest, StreamEvent } from "../../src/core/types";
import { uuidv7 } from "../../src/utils/uuid";

const RESPONSES = [
	[
		"Hello! I am the built-in mock provider for the Murm UI demo.",
		"",
		"This mode is intentionally local: no network request is made, and no API key is needed. You can still try the core chat interactions: send a few messages, edit a prompt, attach a small text file, copy a response, or open Settings to connect a real provider.",
	].join("\n"),
	[
		"Murm UI is built as a small vanilla TypeScript chat shell.",
		"",
		"This answer streams in small chunks so you can see loading states, scroll behavior, stop handling, and incremental rendering without waiting on a real model. The mock is simple, but the UI path is the same one used by a real ChatProvider.",
	].join("\n"),
	[
		"Markdown should feel native in the message feed. Murm UI renders **bold text**, *italics*, tables, and fenced code blocks:",
		"",
		"| Markdown feature | Demo status |",
		"| :--- | :--- |",
		"| Tables | Rendered inline |",
		"| Code fences | Highlighted by language |",
		"| Plain text | Escaped safely |",
		"",
		"```ts",
		"const ui = new ChatUI({",
		'  container: ".mur-app",',
		"  provider,",
		"  storage,",
		"  highlighter: highlight,",
		"});",
		"```",
		"",
		"The code block above goes through the built-in highlighter, so language-tagged snippets can get readable syntax colors out of the box.",
	].join("\n"),
	[
		"Under the hood, Murm UI keeps the chat UI separate from your model transport.",
		"",
		"Bring a provider for your API, pair it with storage you control, and the shell handles session history, streaming updates, attachments, message actions, and the small UI states that make chat apps feel polished.",
	].join("\n"),
];

const FUN_TITLES = [
	"Zero-Framework Vibes",
	"Look Ma, No React!",
	"Markdown Mischief",
	"Streaming Shenanigans",
	"API Key Side Quest",
	"Div Soup Avoided",
];

export class MockProvider implements ChatProvider {
	async streamChat(request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
		return new Promise((resolve) => {
			const messageId = uuidv7();
			const blockId = uuidv7();

			onEvent({
				type: "message_start",
				message: { id: messageId, role: "assistant", blocks: [] },
			});

			const responseIndex = request.messages.filter((message) => message.role === "user").length - 1;
			const chunks = splitIntoChunks(RESPONSES[Math.max(0, responseIndex) % RESPONSES.length]);
			let index = 0;

			// Dynamic Speed: Aim for ~1.1 seconds total, capped between 15ms (fast) and 45ms (normal)
			const intervalMs = Math.max(15, Math.min(45, Math.floor(1100 / chunks.length)));
			const interval = setInterval(() => {
				if (request.signal.aborted) {
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
			}, intervalMs);
		});
	}

	async generateTitle(_request: ChatRequest): Promise<string> {
		const randomTitle = FUN_TITLES[Math.floor(Math.random() * FUN_TITLES.length)];
		return new Promise((resolve) => setTimeout(() => resolve(randomTitle), 600));
	}
}

function splitIntoChunks(text: string): string[] {
	const chunks: string[] = [];
	const size = 7;

	for (let i = 0; i < text.length; i += size) {
		chunks.push(text.slice(i, i + size));
	}

	return chunks;
}
