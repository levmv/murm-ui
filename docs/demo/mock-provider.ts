import type { ChatProvider, Message, RequestOptions, StreamEvent } from "../../src/core/types";
import { uuidv7 } from "../../src/utils/uuid";

export class MockProvider implements ChatProvider {
	async streamChat(
		_messages: Message[],
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

			const cannedResponse =
				"Hello! I am a simulated local provider. I am here to demonstrate the Murm UI interface. You can type anything, and I will stream this response back to you. Feel free to try the attachments, editing, and copying features!";
			const words = cannedResponse.split(" ");
			let index = 0;

			const interval = setInterval(() => {
				if (signal.aborted) {
					clearInterval(interval);
					onEvent({ type: "finish", reason: "aborted" });
					resolve();
					return;
				}

				if (index < words.length) {
					onEvent({
						type: "text_delta",
						messageId,
						blockId,
						delta: words[index] + " ",
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
