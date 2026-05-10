export type { SidebarMenuBuilder, SidebarMenuContext, SidebarMenuItem } from "./components/sidebar";
export { ChatEngine, type ChatEngineConfig } from "./core/chat-engine";
export { OpenAIProvider } from "./core/providers/openai";
export type { ChatSessions } from "./core/session-manager";
export { IndexedDBStorage } from "./core/storage/indexed-db";
export { RemoteStorage, RemoteStorageError, type RemoteStorageOptions } from "./core/storage/remote";
export type {
	ActionButtonDef,
	ChatPlugin,
	ChatProvider,
	ChatRequestPatch,
	ChatSession,
	ChatSessionMeta,
	ChatState,
	ChatStorage,
	CodeHighlighter,
	JsonValue,
	Message,
	MessageActionContext,
	PluginContext,
	PluginInputContext,
	ReadonlyChatRequestParams,
	RequestOptions,
	TokenUsage,
} from "./core/types";
export { MAX_PINNED_SESSIONS } from "./core/types";
export { ChatUI, type ChatUIConfig } from "./main";

export type { AttachmentPluginConfig, FileHandler } from "./plugins/attachment/attachment-plugin";
export type { EditConfig } from "./plugins/edit/edit-plugin";
export type { SettingsPluginConfig, SettingsState, SettingsStorage } from "./plugins/settings/settings-plugin";
