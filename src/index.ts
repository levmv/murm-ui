export { OpenAIProvider as OpenAIAdapter } from "./core/providers/openai";
export { IndexedDBStorage as IndexedDBAdapter } from "./core/storage/indexed-db";
export { RemoteStorage as RemoteStorageAdapter } from "./core/storage/remote";
export type {
	ChatPlugin,
	ChatProvider as ProviderAdapter,
	ChatSession,
	ChatStorage as StorageAdapter,
	Message,
} from "./core/types";
export { ChatUI, type ChatUIConfig } from "./main";

export { AttachmentPlugin } from "./plugins/attachment/attachment-plugin";
export { EditPlugin } from "./plugins/edit/edit-plugin";
export { SettingsPlugin } from "./plugins/settings/settings-plugin";
export { ThinkingPlugin } from "./plugins/thinking/thinking-plugin";
