import { highlight } from "../../src/highlighter";
import { ChatUI, IndexedDBStorage, OpenAIProvider } from "../../src/with-css";
import "../../src/highlighter/theme.css";
import { AttachmentPlugin } from "../../src/plugins/attachment/attachment-plugin";
import { CopyPlugin } from "../../src/plugins/copy/copy-plugin";
import { EditPlugin } from "../../src/plugins/edit/edit-plugin";
import { SettingsPlugin, type SettingsState, type SettingsStorage } from "../../src/plugins/settings/settings-plugin";
import { ThinkingPlugin } from "../../src/plugins/thinking/thinking-plugin";
import { MockProvider } from "./mock-provider";

const DEFAULT_API_ENDPOINT = "";
const DEFAULT_API_MODEL = "";
const DEMO_SETTINGS_KEY = "mur_demo_provider_settings";
const LEGACY_DEFAULT_API_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const LEGACY_DEFAULT_API_MODEL = "gpt-4o-mini";

const demoSettingsStorage: SettingsStorage = {
	async get() {
		const saved = readJson<Partial<SettingsState>>(DEMO_SETTINGS_KEY);
		if (!isLegacySavedMockSettings(saved)) return saved;

		const migrated = { ...saved, apiKey: "", endpoint: "", model: "" };
		localStorage.setItem(DEMO_SETTINGS_KEY, JSON.stringify(migrated));
		return migrated;
	},
	async set(state) {
		localStorage.setItem(DEMO_SETTINGS_KEY, JSON.stringify(state));
	},
};

new ChatUI({
	container: ".mur-app",
	provider: new MockProvider(),
	storage: new IndexedDBStorage("MurmDemoDB"), // Use a separate DB for the demo
	highlighter: highlight,
	plugins: (chatApi) => [
		AttachmentPlugin(),
		ThinkingPlugin(),
		CopyPlugin(),
		EditPlugin({ onSave: (id, text) => chatApi.editAndResubmit(id, text) }),
		SettingsPlugin({
			defaultEndpoint: DEFAULT_API_ENDPOINT,
			defaultModel: DEFAULT_API_MODEL,
			endpointPlaceholder: "https://your-provider.example/v1/chat/completions",
			apiKeyPlaceholder: "Provider API key",
			modelPlaceholder: "provider-model-name",
			storage: demoSettingsStorage,
			createProvider: createDemoProvider,
		}),
	],
});

function createDemoProvider(settings: SettingsState) {
	if (shouldUseMockProvider(settings)) return new MockProvider();
	return new OpenAIProvider(settings.apiKey, settings.endpoint, settings.model);
}

function shouldUseMockProvider(settings: SettingsState): boolean {
	const apiKey = settings.apiKey.trim();
	const endpoint = settings.endpoint.trim();
	const model = settings.model.trim();

	if (endpoint === "" || model === "") return true;
	return apiKey === "" && isLegacyDefault(endpoint, model);
}

function isLegacyDefault(endpoint: string, model: string): boolean {
	return endpoint === LEGACY_DEFAULT_API_ENDPOINT && model === LEGACY_DEFAULT_API_MODEL;
}

function isLegacySavedMockSettings(settings: Partial<SettingsState> | null): boolean {
	if (!settings) return false;

	return (
		(settings.apiKey ?? "").trim() === "" &&
		(settings.endpoint ?? "").trim() === LEGACY_DEFAULT_API_ENDPOINT &&
		(settings.model ?? "").trim() === LEGACY_DEFAULT_API_MODEL
	);
}

function readJson<T>(key: string): T | null {
	try {
		return JSON.parse(localStorage.getItem(key) || "null") as T | null;
	} catch {
		return null;
	}
}
