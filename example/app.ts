import { highlight } from "../src/highlighter";
import {
	AttachmentPlugin,
	ChatUI,
	CopyPlugin,
	EditPlugin,
	IndexedDBStorage,
	OpenAIProvider,
	SettingsPlugin,
	ThinkingPlugin,
} from "../src/index";
import "../src/highlighter/theme.css";

new ChatUI({
	container: ".mur-app",
	provider: new OpenAIProvider("", "", ""), //'https://api.deepseek.com/chat/completions', 'deepseek-reasoner'),
	storage: new IndexedDBStorage(),
	plugins: (chatApi) => [
		AttachmentPlugin(),
		ThinkingPlugin(),
		CopyPlugin(),
		EditPlugin({ onSave: (id, text) => chatApi.editAndResubmit(id, text) }),
		SettingsPlugin({
			defaultModel: "auto",
			defaultEndpoint: "https://openrouter.ai/api/v1/chat/completions",
		}),
	],
	highlighter: highlight,
});
