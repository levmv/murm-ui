import { AttachmentPlugin, ChatUI, CopyPlugin, EditPlugin, IndexedDBStorage, ThinkingPlugin } from "../../src/index";
import { MockProvider } from "./mock-provider";

new ChatUI({
	container: ".mur-app",
	provider: new MockProvider(),
	storage: new IndexedDBStorage("MurmDemoDB"), // Use a separate DB for the demo
	plugins: (chatApi) => [
		AttachmentPlugin(),
		ThinkingPlugin(),
		CopyPlugin(),
		EditPlugin({ onSave: (id, text) => chatApi.editAndResubmit(id, text) }),
	],
});
