import type { ChatLabels } from "../labels";
import type { ChatEngine } from "./chat-engine";
import type { ComposerPlugin } from "./composer-types";
import type { ConversationChange } from "./conversation-types";

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
			/** Application-provided summary, independent of raw arguments. */
			summary?: string;
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
			type: "custom";
			kind: string;
			data: JsonValue;
			fallbackText: string;
	  }
	| {
			id: string;
			type: "file";
			mimeType: string;
			name?: string;
			data: string;
	  };

export type Role = "system" | "user" | "assistant" | "tool";

export interface TokenUsage {
	input: number;
	output: number;
	total: number;
	cacheRead?: number;
	cacheWrite?: number;
	details?: JsonValue;
}

export interface Message {
	id: string;
	role: Role;
	blocks: ContentBlock[];
	/** Groups messages from one run. ChatEngine defaults to the user message ID. */
	runId?: string;
	createdAt?: number;
	updatedAt?: number;
	/** Excludes the message from provider requests and storage. */
	ephemeral?: boolean;
	usage?: TokenUsage;
	/** JSON-serializable provider or plugin metadata, saved with chat history. */
	meta?: Record<string, JsonValue>;
	/** Display state for addressed updates. */
	status?: "streaming" | "complete" | "error";
	error?: string;
}

export interface ChatSessionMeta {
	id: string;
	title: string;
	updatedAt: number;
	isPinned?: boolean;
}

export interface ChatSession {
	id: string;
	title: string;
	updatedAt: number;
	isPinned?: boolean;
	messages: Message[];
	/** True when loadOne returns a partial history with older messages available. */
	hasMoreMessages?: boolean;
	/** Opaque storage cursor for the next older page; independent of Message.id. */
	nextOlderMessagesCursor?: string;
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
	/** Whether the loaded session reports older messages beyond the current page. */
	hasMoreMessages: boolean;
	isLoadingMessages: boolean;
	error: { message: string; id?: string } | null;
}

export interface ChatStorage {
	loadSessions(limit: number, cursor?: ChatSessionMeta): Promise<PaginatedSessions>;
	loadOne(id: string): Promise<ChatSession | null>;
	/** When hasMoreMessages is true, preserve the unloaded prefix and replace only the supplied tail. */
	save(session: ChatSession): Promise<void>;
	updateMetadata?(id: string, meta: Partial<ChatSessionMeta>): Promise<void>;
	delete(id: string): Promise<void>;
	/**
	 * Loads an older page using the nextOlderMessagesCursor from the previous result.
	 * Return messages oldest-first and the next cursor when hasMore is true.
	 * Omit when loadOne always returns the full history.
	 */
	loadOlderMessages?(
		sessionId: string,
		cursor: string,
		limit: number,
	): Promise<{ messages: Message[]; hasMore: boolean; nextOlderMessagesCursor?: string }>;
	close?(): void | Promise<void>;
}

export const MAX_PINNED_SESSIONS = 3;

export type ToolDefinition = Record<string, unknown>;

export interface RequestOptions {
	model?: string;
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	stream_options?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface ChatRequest {
	messages: Message[];
	instructions?: string;
	tools?: ToolDefinition[];
	options: RequestOptions;
	signal: AbortSignal;
}

export interface ChatRequestDefaults {
	instructions?: string;
	tools?: ToolDefinition[];
	options?: Partial<RequestOptions>;
}

/** The engine creates this response before calling the provider. */
export interface ChatStreamRequest extends ChatRequest {
	messageId: string;
	runId: string;
}

export interface ChatProvider {
	/**
	 * Applies the same addressed changes used by ConversationModel and ChatView.
	 * Add blocks before appending deltas. Additional messages need explicit ids and
	 * the request's runId. Resolving completes the run; reject for provider failures.
	 */
	streamChat(request: ChatStreamRequest, onChange: (changes: ConversationChange[]) => void): Promise<void>;

	generateTitle?(request: ChatRequest): Promise<string>;
}

/**
 * Converts code to trusted HTML, optionally after loading a grammar.
 * lang is empty for code blocks without a language. Escape all interpolated code;
 * the returned HTML is inserted without further sanitization.
 */
export type CodeHighlighter = (code: string, lang: string) => string | Promise<string>;

export type AgentRunCollapse = "full" | "machinery";

export interface RenderConfig {
	highlighter?: CodeHighlighter;
	labels?: Readonly<ChatLabels>;
	plugins: MessagePlugin[];
	renderers?: BlockRenderer[];
	showReasoning?: boolean;
	canAct?: () => boolean;
	getConversationId?: () => string;
	onAction?: (action: BlockAction) => void;
	fullscreen?: boolean;
	agentRunCollapse?: AgentRunCollapse;
	minAgentRunSteps?: number;
	/** Called near the top of the transcript when older messages can be loaded. */
	onReachTop?: () => void;
}

type AnyFn = (...args: never[]) => unknown;
type DeepReadonlyDepth = [never, 0, 1, 2, 3, 4, 5];

export type DeepReadonly<T, Depth extends number = 5> = [Depth] extends [never]
	? T
	: T extends AnyFn
		? T
		: T extends readonly (infer Item)[]
			? readonly DeepReadonly<Item, DeepReadonlyDepth[Depth]>[]
			: T extends object
				? { readonly [K in keyof T]: DeepReadonly<T[K], DeepReadonlyDepth[Depth]> }
				: T;

export interface ReadonlyChatRequest {
	readonly messages: readonly DeepReadonly<Message>[];
	readonly instructions?: string;
	readonly tools?: readonly DeepReadonly<ToolDefinition>[];
	readonly options: DeepReadonly<RequestOptions>;
	readonly signal: AbortSignal;
}

export interface ChatRequestPatch {
	messages?: Message[];
	/**
	 * Omit to keep the accumulated request instructions unchanged.
	 * Return `instructions: undefined` to clear inherited instructions.
	 */
	instructions?: string;
	/**
	 * Omit to keep the accumulated request tools unchanged.
	 * Return `tools: undefined` to clear inherited tools.
	 */
	tools?: ToolDefinition[];
	options?: Partial<RequestOptions>;
}

export interface PluginContext {
	engine: ChatEngine;
	container: HTMLElement;
}

export interface MessageActionContext {
	message: Message;
	buttonEl: HTMLElement;
	messageEl: HTMLElement;
	actionId: string;
	pluginName: string;
}

export interface ActionButtonDef {
	/** Stable within a plugin; preserves the button node across message updates. */
	id: string;
	title: string;
	iconHtml: string;
	onClick: (ctx: MessageActionContext) => void;
	/** Set false for actions such as copying that remain available in read-only views. */
	mutates?: boolean;
}

export interface BlockAction {
	conversationId: string;
	messageId: string;
	blockId: string;
	action: string;
	payload?: JsonValue;
}

export interface RendererContext extends BlockRenderContext {
	isGenerating: boolean;
	canAct: boolean;
	dispatch(action: string, payload?: JsonValue): void;
}

/** A renderer owns the contents of one block container until destroy. */
export interface BlockRenderer {
	matches(block: ContentBlock): boolean;
	mount(container: HTMLElement): BlockRendererInstance;
}

export interface BlockRendererInstance {
	update(block: ContentBlock, context: RendererContext): void;
	destroy(): void;
}

export interface BlockRenderContext {
	message: Message;
	messages: readonly Message[];
	blockIndex: number;
	labels?: Readonly<ChatLabels>;
}

/** Presentation hooks shared by standalone views and the ordinary chat. */
export interface MessagePlugin {
	name: string;
	/** First matching renderer owns each block until its lifecycle ends. */
	renderers?: BlockRenderer[];
	/** Fires when the owning view or chat is destroyed. */
	destroy?: () => void;
	/**
	 * Derives actions from the current message. Recomputed on completed-message
	 * updates and when streaming finishes, not for each streaming token.
	 * Keep this hook free of side effects; buttons are reconciled by plugin and id.
	 */
	getActionButtons?: (msg: Message, labels?: Readonly<ChatLabels>) => ActionButtonDef[];
}

export interface ChatPlugin extends MessagePlugin, ComposerPlugin {
	/** Fires once when ChatUI initializes. */
	onMount?: (ctx: PluginContext) => void;

	/**
	 * Called before the provider request. Treat the input as read-only and return
	 * a patch to change it, or undefined to leave it unchanged.
	 */
	beforeSubmit?: (request: ReadonlyChatRequest) => ChatRequestPatch | undefined | Promise<ChatRequestPatch | undefined>;
}
