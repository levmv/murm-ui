import type { ChatState, ContentBlock, Message, StreamEvent } from "./types";

export function applyStreamEventToState(state: ChatState, pendingId: string, event: StreamEvent): void {
	let msg: Message | undefined = state.messages[state.messages.length - 1];
	if (msg?.id !== pendingId) {
		msg = state.messages.find((m) => m.id === pendingId);
	}
	if (!msg) return; // Only happens if user rapidly deleted the chat during stream

	switch (event.type) {
		case "message_start":
			// We already pushed a placeholder. We can optionally merge metadata.
			if (event.message.meta) {
				msg.meta = { ...msg.meta, ...event.message.meta };
			}
			break;

		case "text_delta": {
			let tb = msg.blocks.find((b) => b.id === event.blockId) as Extract<ContentBlock, { type: "text" }>;
			if (!tb) {
				tb = { id: event.blockId, type: "text", text: "" };
				msg.blocks.push(tb);
			}
			tb.text += event.delta;
			break;
		}

		case "reasoning_delta": {
			let rb = msg.blocks.find((b) => b.id === event.blockId) as Extract<ContentBlock, { type: "reasoning" }>;
			if (!rb) {
				rb = { id: event.blockId, type: "reasoning", text: "", encrypted: event.encrypted };
				msg.blocks.push(rb);
			}
			if (event.encrypted) {
				rb.encrypted = true;
				if (event.delta) {
					rb.encryptedText = (rb.encryptedText ?? "") + event.delta;
				}
			} else {
				rb.text += event.delta;
			}
			break;
		}

		case "tool_call_start":
			msg.blocks.push(event.block);
			break;

		case "tool_call_delta": {
			const tcb = msg.blocks.find((b) => b.id === event.blockId) as Extract<ContentBlock, { type: "tool_call" }>;
			if (tcb) {
				if (event.name !== undefined) tcb.name = event.name;
				if (event.argsDelta) tcb.argsText += event.argsDelta;
				if (event.status) tcb.status = event.status;
			}
			break;
		}

		case "tool_result":
		case "artifact":
			msg.blocks.push(event.block);
			break;
		case "finish": {
			const finalStatus = event.reason === "error" || event.reason === "aborted" ? "error" : "complete";
			for (const b of msg.blocks) {
				if (b.type === "tool_call" && b.status === "streaming") {
					b.status = finalStatus;
				}
			}
			break;
		}
		// Usage, finish, error handled mostly outside mutation or discarded
		case "error":
			state.error = { message: event.message, id: pendingId };
			break;
	}
}
