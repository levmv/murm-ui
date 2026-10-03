/** Strings shared by ChatView, Composer and the built-in message renderers. */
export interface ChatLabels {
	message: string;
	messagePlaceholder: string;
	send: string;
	stop: string;
	attach: string;
	attachments: string;
	uploading: string;
	removeAttachment: (name: string) => string;
	loadingOlder: string;
	assistant: string;
	copyMessage: string;
	copyCode: string;
	file: string;
	toolCall: (name: string, status: string) => string;
	thinking: string;
	thoughtProcess: string;
	hiddenReasoning: string;
	toggleReasoning: string;
	toolArguments: string;
	toolResult: string;
	toolStatus: (status: string) => string;
	toolRunning: string;
	toolFailed: string;
	toolNoResult: string;
	toolError: string;
	toolWaiting: string;
	workSummary: (toolCalls: number, reasoningOnly: boolean, durationMs?: number) => string;
}

export const defaultLabels: Readonly<ChatLabels> = {
	message: "Message",
	messagePlaceholder: "Message…",
	send: "Send message",
	stop: "Stop generation",
	attach: "Attach files",
	attachments: "Attachments",
	uploading: "Uploading…",
	removeAttachment: (name) => `Remove ${name}`,
	loadingOlder: "Loading older messages...",
	assistant: "AI response",
	copyMessage: "Copy message",
	copyCode: "Copy code",
	file: "File",
	toolCall: (name, status) => `Tool Call: ${name} (${status})`,
	thinking: "Thinking...",
	thoughtProcess: "Thought Process",
	hiddenReasoning: "Thought process is hidden by the model provider.",
	toggleReasoning: "Toggle reasoning",
	toolArguments: "Arguments",
	toolResult: "Result",
	toolStatus: (status) => status,
	toolRunning: "Running...",
	toolFailed: "Tool failed.",
	toolNoResult: "No result.",
	toolError: "Error",
	toolWaiting: "Waiting for result...",
	workSummary(toolCalls, reasoningOnly, durationMs) {
		const duration = durationMs === undefined || durationMs <= 0 ? "" : formatDuration(durationMs);
		if (toolCalls > 0) return `${toolCalls} tool call${toolCalls === 1 ? "" : "s"}${duration ? `, ${duration}` : ""}`;
		return `${reasoningOnly ? "Thought" : "Worked"}${duration ? ` for ${duration}` : ""}`;
	},
};

function formatDuration(durationMs: number): string {
	if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
	const seconds = Math.round(durationMs / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
