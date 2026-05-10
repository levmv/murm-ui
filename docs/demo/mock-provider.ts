import type { ChatProvider, Message, RequestOptions, StreamEvent } from "../../src/core/types";
import { uuidv7 } from "../../src/utils/uuid";

const RESPONSES = [
	[
		"Hello! I am the local demo provider for Murm UI. 🚀",
		"",
		"Try sending a few messages, editing your prompt, attaching a small text file, or copying this response. Everything here runs entirely in your browser, so no API keys were harmed in the making of this demo.",
	].join("\n"),
	[
		"Notice how snappy this feels? That is the beauty of vanilla TypeScript.",
		"",
		"Because there is no virtual DOM diffing, the UI just updates the exact nodes it needs to using reference-based DOM updates. It is designed to keep your laptop fan quiet, even if I stream a massive wall of text at you.",
	].join("\n"),
	[
		"I also handle markdown parsing right out of the box. I can do **bold text**, *italics*, and even tables:",
		"",
		"| Feature | Status |",
		"| :--- | :--- |",
		"| Dependencies | Minimal |",
		"| Overhead | Low |",
		"| Vibes | Immaculate |",
		"",
		"And of course, code blocks render cleanly. Murm UI ships a built-in highlighter for syntax colors.",
	].join("\n"),
	[
		"Ultimately, Murm UI just wants to be a boring, reliable chat shell.",
		"",
		"You bring your own backend, plug in your AI model, and let the UI handle the messy streaming states and scroll locking. Feel free to poke around the source code, or just keep chatting with me!",
	].join("\n"),
];

const FUN_TITLES = [
	"Existential AI Crisis",
	"Zero-Framework Vibes",
	"Vanilla JS Renaissance",
	"Look Ma, No React!",
	"Div Soup Avoided",
	"Just Chillin' Locally",
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

			// Dynamic Speed: Aim for ~1.1 seconds total, capped between 15ms (fast) and 45ms (normal)
			const intervalMs = Math.max(15, Math.min(45, Math.floor(1100 / chunks.length)));
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
			}, intervalMs);
		});
	}

	async generateTitle(_messages: Message[], _options?: RequestOptions, _signal?: AbortSignal): Promise<string> {
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
