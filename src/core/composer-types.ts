import type { ChatLabels } from "../labels";
import type { ContentBlock } from "./types";

export interface ComposerCapabilities {
	canSubmit: boolean;
	/** Whether drafts can be edited. Defaults to canSubmit; may stay true while the provider is busy. */
	canEdit?: boolean;
	/** The application currently has work that this user can stop. */
	canStop: boolean;
}

export interface SubmitCommand {
	conversationId: string;
	clientRequestId: string;
	text: string;
	blocks: ContentBlock[];
	/** Aborted on composer destruction so the application can cancel a pending submission. */
	signal: AbortSignal;
}

export interface ComposerContext {
	readonly container: HTMLElement;
	readonly form: HTMLFormElement;
	readonly input: HTMLTextAreaElement;
	readonly labels: Readonly<ChatLabels>;
	readonly conversationId: string;
	readonly canEdit: boolean;
	/** Call when plugin draft content changes, including asynchronous results. */
	changed(conversationId?: string): void;
}

export interface ComposerExtension {
	/** Refreshes the extension UI when the composer state changes. */
	update?(): void;
	hasContent?(): boolean;
	isBlocked?(): boolean;
	/** Capture submitted blocks and clear only that captured draft on acceptance. */
	collect?(): { blocks: ContentBlock[]; accept(): void };
	destroy(): void;
}

export interface ComposerPlugin {
	name: string;
	mountComposer?: (context: ComposerContext) => ComposerExtension;
}
