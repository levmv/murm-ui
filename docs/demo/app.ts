import { highlight } from "../../src/highlighter";
import { ChatUI, IndexedDBStorage, OpenAIProvider } from "../../src/with-css";
import "../../src/highlighter/theme.css";
import { AttachmentPlugin } from "../../src/plugins/attachment/attachment-plugin";
import { CopyPlugin } from "../../src/plugins/copy/copy-plugin";
import { EditPlugin } from "../../src/plugins/edit/edit-plugin";
import { SettingsPlugin, type SettingsState, type SettingsStorage } from "../../src/plugins/settings/settings-plugin";
import { ThinkingPlugin } from "../../src/plugins/thinking/thinking-plugin";
import { ToolsPlugin } from "../../src/plugins/tools/tools-plugin";
import { MockProvider } from "./mock-provider";

const DEMO_SETTINGS_KEY = "mur_demo_provider_settings";

const demoSettingsStorage: SettingsStorage = {
	async get() {
		const saved = JSON.parse(localStorage.getItem(DEMO_SETTINGS_KEY) || "null") as Partial<SettingsState> | null;
		// Earlier demos saved these defaults even when using the local provider.
		if (
			saved &&
			!(saved.apiKey ?? "").trim() &&
			saved.endpoint?.trim() === "https://api.openai.com/v1/chat/completions" &&
			saved.model?.trim() === "gpt-4o-mini"
		)
			return { ...saved, endpoint: "", model: "" };
		return saved;
	},
	async set(state) {
		localStorage.setItem(DEMO_SETTINGS_KEY, JSON.stringify(state));
	},
};

new ChatUI({
	container: ".mur-app",
	provider: new MockProvider(),
	storage: new IndexedDBStorage("MurmDemoDB"),
	highlighter: highlight,
	plugins: (chatApi) => [
		AttachmentPlugin(),
		ThinkingPlugin(),
		ToolsPlugin(),
		CopyPlugin(),
		EditPlugin({ onSave: (id, text) => chatApi.editAndResubmit(id, text) }),
		SettingsPlugin({
			defaultEndpoint: "",
			defaultModel: "",
			endpointPlaceholder: "https://your-provider.example/v1/chat/completions",
			apiKeyPlaceholder: "Provider API key",
			modelPlaceholder: "provider-model-name",
			storage: demoSettingsStorage,
			createProvider: ({ apiKey, endpoint, model }) =>
				endpoint.trim() && model.trim() ? new OpenAIProvider(apiKey, endpoint, model) : new MockProvider(),
		}),
	],
});
