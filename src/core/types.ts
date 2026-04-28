import type { ChatEngine } from "./chat-engine";

export type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];

export type ContentBlock =
	| {
			id: string;
			type: "text";
			text: string;
	  }
	| {
			id: string;
			type: "reasoning";
			text: string;
			encrypted?: boolean;
			encryptedText?: string;
	  }
	| {
			id: string;
			type: "tool_call";
			toolCallId: string;
			name: string;
			argsText: string;
			status: "streaming" | "pending" | "running" | "complete" | "error";
	  }
	| {
			id: string;
			type: "tool_result";
			toolCallId: string;
			outputText: string;
			isError?: boolean;
	  }
	| {
			id: string;
			type: "artifact";
			artifactId: string;
			mime: string;
			title?: string;
			content: string;
	  }
	| {
			id: string;
			type: "file";
			mimeType: string;
			name?: string;
			data: string;
	  };

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
	id: string;
	role: Role;
	blocks: ContentBlock[];
	meta?: {
		// Used to prevent this message from being sent to the LLM
		ephemeral?: boolean;
		// Escape hatch for plugin developers to store custom state
		[key: string]: unknown;
	};
}

export type FinishReason = "stop" | "length" | "tool_use" | "content_filter" | "error" | "aborted";

export type StreamEvent =
	| {
			type: "message_start";
			message: Message;
	  }
	| {
			type: "text_delta";
			messageId: string;
			blockId: string;
			delta: string;
	  }
	| {
			type: "reasoning_delta";
			messageId: string;
			blockId: string;
			delta: string;
			encrypted?: boolean;
	  }
	| {
			type: "tool_call_start";
			messageId: string;
			block: Extract<ContentBlock, { type: "tool_call" }>;
	  }
	| {
			type: "tool_call_delta";
			messageId: string;
			blockId: string;
			name?: string;
			argsDelta?: string;
			status?: Extract<ContentBlock, { type: "tool_call" }>["status"];
	  }
	| {
			type: "tool_result";
			messageId: string;
			block: Extract<ContentBlock, { type: "tool_result" }>;
	  }
	| {
			type: "artifact";
			messageId: string;
			block: Extract<ContentBlock, { type: "artifact" }>;
	  }
	| {
			type: "usage";
			input: number;
			output: number;
			cacheRead?: number;
			cacheWrite?: number;
	  }
	| {
			type: "error";
			message: string;
			code?: string;
			retryable?: boolean;
	  }
	| {
			type: "finish";
			reason: FinishReason;
	  };

export interface ChatSessionMeta {
	id: string;
	title: string;
	updatedAt: number;
}

export interface ChatSession {
	id: string;
	title: string;
	updatedAt: number;
	messages: Message[];
}

export interface PaginatedSessions {
	items: ChatSessionMeta[];
	hasMore: boolean;
}

export interface ChatState {
	sessions: ChatSessionMeta[];
	hasMoreSessions: boolean;
	currentSessionId: string;
	messages: Message[];
	generatingMessageId: string | null;
	isLoadingSession: boolean;
	isLoadingSessions: boolean;
	error: { message: string; id?: string } | null;
}

export interface ChatStorage {
	loadSessions(limit: number, cursor?: { updatedAt: number; id: string }): Promise<PaginatedSessions>;
	loadOne(id: string): Promise<ChatSession | null>;
	save(session: ChatSession): Promise<void>;
	updateMetadata?(id: string, meta: Partial<ChatSessionMeta>): Promise<void>;
	delete(id: string): Promise<void>;
	close?(): void | Promise<void>;
}

export interface RequestOptions {
	model?: string;
	systemPrompt?: string;
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	tools?: Record<string, unknown>[];
	stream_options?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface ChatRequestParams {
	messages: Message[];
	options: RequestOptions;
	signal: AbortSignal;
}

export interface ChatProvider {
	streamChat(
		messages: Message[],
		options: RequestOptions,
		signal: AbortSignal,
		onEvent: (event: StreamEvent) => void,
	): Promise<void>;

	generateTitle?(messages: Message[], options?: RequestOptions, signal?: AbortSignal): Promise<string>;
}

export interface RenderConfig {
	highlighter?: (code: string, lang: string) => string;
	plugins: ChatPlugin[];
}

type AnyFn = (...args: never[]) => unknown;

export type DeepReadonly<T> = T extends AnyFn
	? T
	: T extends object
		? { readonly [K in keyof T]: DeepReadonly<T[K]> }
		: T;

export interface ReadonlyChatRequestParams {
	readonly messages: readonly DeepReadonly<Message>[];
	readonly options: DeepReadonly<RequestOptions>;
	readonly signal: AbortSignal;
}

export interface ChatRequestPatch {
	messages?: Message[];
	options?: Partial<RequestOptions>;
}

export interface PluginContext {
	engine: ChatEngine;
	container: HTMLElement;
}

export interface PluginInputContext {
	container: HTMLElement;
	form: HTMLFormElement;
	input: HTMLTextAreaElement;
	requestSubmitStateSync: () => void;
}

export interface MessageActionContext {
	message: Message;
	buttonEl: HTMLElement;
	messageEl: HTMLElement;
	actionId: string;
	pluginName: string;
}

export interface ActionButtonDef {
	id: string;
	title: string;
	iconHtml: string;
	onClick: (ctx: MessageActionContext) => void;
}

export interface ChatPlugin {
	name: string;

	/**
	 * Fires once when the chat UI initializes.
	 */
	onMount?: (ctx: PluginContext) => void;

	/**
	 * Fires when the chat instance is destroyed.
	 */
	destroy?: () => void;

	/**
	 * Intercept and mutate the payload (messages, options) right before it is sent to the LLM.
	 * To optimize performance, the payload is typed as readonly.
	 * Return a ChatRequestPatch to override specific parts, or void if no changes are needed.
	 * This hook may be async.
	 */
	beforeSubmit?: (
		params: ReadonlyChatRequestParams,
	) => ChatRequestPatch | undefined | Promise<ChatRequestPatch | undefined>;

	/**
	 * Fires when the input area mounts. Use to append/prepend custom UI to the form.
	 */
	onInputMount?: (ctx: PluginInputContext) => void;

	/**
	 * Allows the input form to be submitted even if the text area is empty.
	 */
	hasPendingData?: () => boolean;

	/**
	 * Blocks user submission while a plugin is resolving async input state.
	 */
	isSubmitBlocked?: () => boolean;

	/**
	 * Intercept and mutate a newly created user message before it is saved and sent.
	 * This hook must finish synchronously; use beforeSubmit for async request shaping.
	 */
	onUserSubmit?: (msg: Message) => void;

	/**
	 * Intercept the rendering of an entire message container.
	 * Ideal for adding message-level UI (e.g., action buttons) to the outer wrapper.
	 * * @param msg The full message data.
	 * @param parentEl The outer DOM element wrapping the entire message.
	 * @param isGenerating True if the LLM is actively streaming this message.
	 */
	onMessageRender?: (msg: Message, parentEl: HTMLElement, isGenerating: boolean) => void;

	/**
	 * Declaratively registers static icon buttons for a message action bar.
	 * Called when the action bar is first initialized for a message node.
	 */
	getActionButtons?: (msg: Message) => ActionButtonDef[];

	/**
	 * Intercept the rendering of an individual content block (e.g., text, reasoning, tool_call).
	 * Use this to inject custom UI directly inside a specific block's container.
	 * * @param block The content block data.
	 * @param containerEl The DOM element wrapping this specific block.
	 * @param isGenerating True if the LLM is actively streaming this block.
	 * @returns `true` if the plugin handled the render, preventing the core UI from overwriting it.
	 */
	onBlockRender?: (block: ContentBlock, containerEl: HTMLElement, isGenerating: boolean) => boolean;
}
