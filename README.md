# Murm UI

A zero-framework, vanilla TypeScript chat interface for LLMs.

Use `ChatUI` for a complete chat with a model provider and history storage, or combine `ChatView`, `Composer` and `Sidebar` with your own backend.

- Streaming Markdown with incremental DOM updates and optional syntax highlighting.
- Plugins for tool calls, reasoning, attachments and message actions.
- Light and dark themes, fullscreen and embedded layouts.
- One runtime dependency: `marked`. No UI framework or virtual DOM.

[Documentation](docs/guide.md) · [Demo](https://levmv.github.io/murm-ui/demo/)

## Install

```sh
npm install murm-ui
```

## Quick start

Start from the [HTML shell](docs/chat-shell.html), then connect a provider and storage:

```ts
import { ChatUI, IndexedDBStorage, OpenAIProvider } from "murm-ui/with-css";
import { CopyPlugin } from "murm-ui/plugins/copy";

new ChatUI({
  container: ".mur-app",
  provider: new OpenAIProvider("", "/api/chat/completions", "your-model"),
  storage: new IndexedDBStorage(),
  plugins: () => [CopyPlugin()],
});
```

`OpenAIProvider` accepts OpenAI-compatible endpoints, including local servers and application proxies. `murm-ui/with-css` includes the core styles; plugin imports include their own CSS.

For an application that already manages conversations and requests, see [ChatView and Composer](docs/guide.md#chatview-and-composer). They create their own markup and work independently of providers and storage.

## Development

Run `npm ci`, then:

- `npm run dev:next` — component demo at `http://localhost:8000`.
- `npm run build:demo` — documentation and chat demo in `docs/dist`.
- `npm run verify` — lint, types, tests, build and package checks.
