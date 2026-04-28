import Prism from "prismjs";
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

import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-php";

import "prismjs/components/prism-python";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-java";
import "prismjs/components/prism-go";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-ruby";

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
	highlighter: (code, lang) => {
		const grammar = Prism.languages[lang];
		if (grammar) {
			return Prism.highlight(code, grammar, lang);
		}
		return code;
	},
});
