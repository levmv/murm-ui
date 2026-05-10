import { highlight } from "../../src/highlighter";
import { ChatUI, IndexedDBStorage } from "../../src/with-css";
import "../../src/highlighter/theme.css";
import { AttachmentPlugin } from "../../src/plugins/attachment/attachment-plugin";
import { CopyPlugin } from "../../src/plugins/copy/copy-plugin";
import { EditPlugin } from "../../src/plugins/edit/edit-plugin";
import { ThinkingPlugin } from "../../src/plugins/thinking/thinking-plugin";
import { MockProvider } from "./mock-provider";

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
	],
});
