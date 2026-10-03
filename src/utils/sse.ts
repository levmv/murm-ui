const MAX_EVENT_SIZE = 1024 * 1024;

/**
 * Reads SSE payloads from a fetch response, joining each event's data fields.
 * Ignores event, id and retry fields. Return true from onMessage to cancel the stream.
 */
export async function parseSSE(response: Response, onMessage: (data: string) => boolean | undefined): Promise<void> {
	if (!response.body) throw new Error("No response body");

	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8");
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();

			if (value) {
				buffer += decoder.decode(value, { stream: true });
			}

			if (done) {
				buffer += decoder.decode();
			}

			while (true) {
				const boundary = /\r?\n\r?\n/.exec(buffer);
				if (!boundary) break;
				if (boundary.index > MAX_EVENT_SIZE) {
					throw new Error("SSE parse error: event exceeded 1MB limit.");
				}

				const eventText = buffer.substring(0, boundary.index);
				buffer = buffer.substring(boundary.index + boundary[0].length);

				if (eventText.length > 0) {
					const data = parseEventData(eventText);
					// An empty string is a valid payload; null means no data field.
					if (data !== null) {
						if (onMessage(data)) {
							await reader.cancel();
							return;
						}
					}
				}
			}

			if (buffer.length > MAX_EVENT_SIZE) {
				throw new Error("SSE parse error: event exceeded 1MB limit.");
			}
			if (done) break;
		}

		if (buffer.length > 0) {
			const data = parseEventData(buffer);
			if (data !== null) onMessage(data);
		}
	} catch (error) {
		// releaseLock() alone leaves the response streaming after an error.
		try {
			await reader.cancel();
		} catch {
			// Preserve the original error if cancellation fails.
		}
		throw error;
	} finally {
		reader.releaseLock();
	}
}

function parseEventData(eventText: string): string | null {
	let data: string | null = null;
	let start = 0;

	while (start < eventText.length) {
		let end = eventText.indexOf("\n", start);
		if (end === -1) end = eventText.length;

		let line = eventText.substring(start, end);

		// Remove the remaining CR from a CRLF line ending.
		if (line.endsWith("\r")) {
			line = line.substring(0, line.length - 1);
		}

		if (line.startsWith("data:")) {
			let value = line.substring(5);
			// SSE strips exactly one optional space after the colon.
			if (value.startsWith(" ")) {
				value = value.substring(1);
			}

			if (data === null) {
				data = value;
			} else {
				data += "\n" + value;
			}
		}

		start = end + 1;
	}

	return data;
}
