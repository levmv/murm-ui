import { highlight } from "../src/highlighter";
import { ChatUI, IndexedDBStorage, OpenAIProvider } from "../src/with-css";
import "../src/highlighter/theme.css";
import { AttachmentPlugin } from "../src/plugins/attachment/attachment-plugin";
import { CopyPlugin } from "../src/plugins/copy/copy-plugin";
import { EditPlugin } from "../src/plugins/edit/edit-plugin";
import { SettingsPlugin } from "../src/plugins/settings/settings-plugin";
import { ThinkingPlugin } from "../src/plugins/thinking/thinking-plugin";
import { ToolsPlugin } from "../src/plugins/tools/tools-plugin";

new ChatUI({
	container: ".mur-app",
	provider: new OpenAIProvider("", "", ""), //'https://api.deepseek.com/chat/completions', 'deepseek-reasoner'),
	storage: new IndexedDBStorage(),
	plugins: (chatApi) => [
		AttachmentPlugin(),
		ThinkingPlugin(),
		ToolsPlugin(),
		CopyPlugin(),
		EditPlugin({ onSave: (id, text) => chatApi.editAndResubmit(id, text) }),
		SettingsPlugin({
			defaultModel: "auto",
			defaultEndpoint: "https://openrouter.ai/api/v1/chat/completions",
		}),
	],
	highlighter: highlight,
});
