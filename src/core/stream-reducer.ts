import type { ChatState, ContentBlock, Message, StreamEvent } from "./types";

type StreamErrorEvent = {
	type: "error";
	message: string;
};

export type StreamReducerEvent = StreamEvent | StreamErrorEvent;

function clearEphemeralFlag(msg: Message): void {
	if (!msg.ephemeral) return;
	delete msg.ephemeral;
}

export function applyStreamEventToState(state: ChatState, pendingId: string, event: StreamReducerEvent): void {
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
			if (event.delta.length > 0) clearEphemeralFlag(msg);
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
			if (event.delta.length > 0) clearEphemeralFlag(msg);
			break;
		}

		case "tool_call_start":
			msg.blocks.push(event.block);
			clearEphemeralFlag(msg);
			break;

		case "tool_call_delta": {
			const tcb = msg.blocks.find((b) => b.id === event.blockId) as Extract<ContentBlock, { type: "tool_call" }>;
			if (tcb) {
				if (event.name !== undefined) tcb.name = event.name;
				if (event.argsDelta) tcb.argsText += event.argsDelta;
				if (event.status) tcb.status = event.status;
				if (event.name !== undefined || event.argsDelta || event.status) clearEphemeralFlag(msg);
			}
			break;
		}

		case "tool_result":
		case "artifact":
			msg.blocks.push(event.block);
			clearEphemeralFlag(msg);
			break;
		case "usage":
			msg.usage = {
				input: event.input,
				output: event.output,
				total: event.total ?? event.input + event.output,
				...(event.cacheRead !== undefined ? { cacheRead: event.cacheRead } : {}),
				...(event.cacheWrite !== undefined ? { cacheWrite: event.cacheWrite } : {}),
				...(event.details !== undefined ? { details: event.details } : {}),
			};
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
		case "error":
			state.error = { message: event.message, id: pendingId };
			for (const b of msg.blocks) {
				if (b.type === "tool_call" && b.status === "streaming") {
					b.status = "error";
				}
			}
			break;
	}
}
