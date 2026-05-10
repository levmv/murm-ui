# Murm UI Documentation

Murm UI is a zero-framework TypeScript chat interface for LLM apps. It handles the browser UI, streaming rendering, chat history, and common controls. Your app brings the provider, storage, and optional plugins.

## Contents

- [Install](#install)
- [HTML Shell](#html-shell)
- [CSS](#css)
- [Create The UI](#create-the-ui)
- [Syntax Highlighting](#syntax-highlighting)
- [Providers](#providers)
- [Plugins](#plugins)
- [Storage](#storage)
- [Browser Support](#browser-support)

<h2 id="install">Install</h2>

```sh
npm install murm-ui
```

<h2 id="html-shell">HTML Shell</h2>

`ChatUI` expects a small set of class names so it can attach the sidebar, feed, and input behavior.

```html
<div class="mur-app">
  <aside class="mur-sidebar">
    <div class="mur-sidebar-header">...</div>
    <div class="mur-sidebar-actions">...</div>
    <div class="mur-sidebar-content"></div>
  </aside>

  <main class="mur-main-area">
    <header class="mur-main-header">
      <button class="mur-open-sidebar-btn" type="button">Menu</button>
      <h2 class="mur-header-title">New Chat</h2>
    </header>

    <div class="mur-chat-layout-wrapper">
      <div class="mur-chat-scroll-area">
        <div class="mur-chat-history" role="log" aria-live="polite"></div>
      </div>

      <div class="mur-chat-form-container">
        <form class="mur-chat-form">
          <textarea class="mur-chat-input" rows="1"></textarea>
          <button class="mur-send-btn mur-form-icon-btn mur-action-btn" type="submit">Send</button>
        </form>
      </div>
    </div>
  </main>
</div>
```

For a complete static shell, see `docs/demo/index.html`.

<h2 id="css">CSS</h2>

The root `murm-ui` entry does not import CSS. For bundlers that support CSS imports, use `murm-ui/with-css` to include the core styles automatically. You can also import CSS explicitly.

```ts
import "murm-ui/styles/base.css";
import "murm-ui/styles/sidebar.css";
import "murm-ui/styles/input.css";
import "murm-ui/styles/feed.css";
import "murm-ui/styles/dropdown.css";
import "murm-ui/plugins/attachment/attachment.css";
import "murm-ui/plugins/edit/edit.css";
import "murm-ui/plugins/settings/settings.css";
import "murm-ui/plugins/thinking/thinking.css";
import "murm-ui/highlighter/theme.css";
```

Theme tokens are scoped to `.mur-app` and use the `--mur-*` prefix. Set `data-theme="light"` or `data-theme="dark"` on `.mur-app`, or omit `data-theme` to follow `prefers-color-scheme`.

<h2 id="create-the-ui">Create The UI</h2>

```ts
import {
  ChatUI,
  IndexedDBStorage,
  OpenAIProvider,
} from "murm-ui/with-css";
import { highlight } from "murm-ui/highlighter";
import { AttachmentPlugin } from "murm-ui/plugins/attachment";
import { CopyPlugin } from "murm-ui/plugins/copy";
import { EditPlugin } from "murm-ui/plugins/edit";
import { ThinkingPlugin } from "murm-ui/plugins/thinking";

new ChatUI({
  container: ".mur-app",
  provider: new OpenAIProvider(apiKey, endpoint, model),
  storage: new IndexedDBStorage(),
  highlighter: highlight,
  plugins: (chatApi) => [
    AttachmentPlugin(),
    ThinkingPlugin(),
    CopyPlugin(),
    EditPlugin({ onSave: (id, text) => chatApi.editAndResubmit(id, text) }),
  ],
});
```

You can customize sidebar menus without replacing Murm UI's defaults:

```ts
new ChatUI({
  // ...
  sidebarMenu: (defaults, ctx) => [
    ...defaults,
    {
      id: "archive",
      label: "Archive",
      onClick: () => archiveChat(ctx.session.id),
    },
  ],
});
```

The `sidebarMenu` builder should stay pure. Return the final item list from the defaults and context, and put side effects inside item `onClick` handlers.

<h2 id="syntax-highlighting">Syntax Highlighting</h2>

Syntax highlighting is optional. If you omit `highlighter`, Murm UI still renders safe code blocks with language labels and copy buttons; it just leaves the code text uncolored.

The package includes a built-in highlighter with common languages already registered. Import the highlighter function and its theme when you want first-party highlighting without adding another runtime dependency.

```ts
import { highlight } from "murm-ui/highlighter";
import "murm-ui/highlighter/theme.css";

new ChatUI({
  // ...
  highlighter: highlight,
});
```

The built-in set includes JavaScript, TypeScript, JSON, YAML, CSS, HTML/XML, JSX, TSX, Python, Bash, SQL, Diff, Markdown, Go, Rust, Java, C, C++, C#, PHP, Ruby, Kotlin, Swift, Dockerfile, TOML, and GraphQL. Unknown languages and plain code blocks are escaped safely.

You can replace it with any trusted highlighter. The function receives raw code text and the language id from the Markdown fence, then returns the HTML fragment that should go inside the `<code>` element.

```ts
new ChatUI({
  // ...
  highlighter: (code, language) => myHighlighter.renderCodeInnerHtml(code, language),
});
```

Custom highlighter output is injected directly for streaming performance, so escape any user code you interpolate and do not return untrusted HTML.

For larger apps, `murm-ui/highlighter/chat` exposes an async highlighter that can lazy-load extra grammars. Built-in languages are available immediately; `loadLanguage` is called only for missing languages.

```ts
import { createHighlighter } from "murm-ui/highlighter/chat";
import "murm-ui/highlighter/theme.css";

const highlighter = createHighlighter({
  async loadLanguage(language) {
    return import(`./grammars/${language}.js`);
  },
});

new ChatUI({
  // ...
  highlighter: highlighter.highlight,
});
```

Grammar definitions use the Prism-style grammar shape (`pattern`, `inside`, `lookbehind`, `greedy`, `alias`, `rest`), so Prism-compatible grammars can be registered directly. If a lazy module exports a raw grammar object, wrap it as a language definition:

```ts
const highlighter = createHighlighter({
  async loadLanguage(language) {
    const module = await import(`./prism-grammars/${language}.js`);
    return { id: language, grammar: module.default };
  },
});
```

<h2 id="providers">Providers</h2>

Providers are the boundary between Murm UI and the model. A provider receives a normalized chat request and streams normalized events back into the engine.

```ts
interface ChatRequest {
  messages: Message[];
  instructions?: string;
  tools?: Record<string, unknown>[];
  options: RequestOptions;
  signal: AbortSignal;
}

interface ChatProvider {
  streamChat(
    request: ChatRequest,
    onEvent: (event: StreamEvent) => void,
  ): Promise<void>;

  generateTitle?(request: ChatRequest): Promise<string>;
}
```

Use `OpenAIProvider` for OpenAI-compatible chat completion endpoints.

```ts
import { OpenAIProvider } from "murm-ui";

const provider = new OpenAIProvider(
  apiKey,
  "https://api.openai.com/v1/chat/completions",
  "gpt-4o-mini",
);
```

For browser apps, a backend proxy is usually the production boundary. BYOK and local tools can pass user-provided keys directly and keep them on that user's device.

`instructions` and `tools` are first-class model inputs on `ChatRequest`. Provider adapters decide how to serialize them for a specific API, such as OpenAI-compatible `system` messages and `tools`, Anthropic top-level `system`, or another provider-native shape.

`RequestOptions` is intentionally open-ended for generation controls and provider-specific passthrough fields. Common options include `model`, `temperature`, `top_p`, `max_tokens`, `stream_options`, and provider-specific flags.

The hosted demo uses a mock provider so visitors can try streaming without an API key or backend.

<h2 id="plugins">Plugins</h2>

Plugins add behavior around input, rendering, request preparation, and message actions.

- `AttachmentPlugin()` adds file attachment handling and previews.
- `ThinkingPlugin()` renders reasoning blocks behind an expandable control.
- `CopyPlugin()` adds message copy actions.
- `EditPlugin()` lets users edit a prior user message and resubmit from that point.
- `SettingsPlugin()` adds browser-side provider settings for apps that want user-configurable endpoints. Its default storage keeps settings in this browser; shared deployments usually pair it with custom storage or a backend proxy.

```ts
import { AttachmentPlugin } from "murm-ui/plugins/attachment";
import { CopyPlugin } from "murm-ui/plugins/copy";
import { EditPlugin } from "murm-ui/plugins/edit";
import { ThinkingPlugin } from "murm-ui/plugins/thinking";

new ChatUI({
  container: ".mur-app",
  provider,
  storage,
  plugins: (chatApi) => [
    AttachmentPlugin(),
    ThinkingPlugin(),
    CopyPlugin(),
    EditPlugin({
      onSave: (id, text) => chatApi.editAndResubmit(id, text),
    }),
  ],
});
```

Plugin entrypoints import their own CSS. If you do not import a plugin entrypoint, its code and styles stay out of the app bundle. Plugin CSS files are also exported separately for apps that manage styles explicitly.

<h2 id="storage">Storage</h2>

Storage adapters persist chat sessions and metadata. Murm UI ships with browser-local IndexedDB storage and a REST-oriented remote storage adapter.

```ts
import { IndexedDBStorage, RemoteStorage } from "murm-ui";

const localStorage = new IndexedDBStorage();
const remoteStorage = new RemoteStorage("/api", getToken);
```

When `getToken` returns a token, `RemoteStorage` sends `Authorization: Bearer <token>`.

Remote storage endpoints:

- `GET /api/chats` lists chat metadata.
- `GET /api/chats/:id` loads one chat with messages.
- `PUT /api/chats/:id` saves a chat document.
- `POST /api/chats/:id/meta` updates metadata such as generated titles.
- `DELETE /api/chats/:id` deletes a chat.

Chat metadata may include `isPinned?: boolean`. If your app exposes the built-in Pin menu item, custom storage should preserve that field, return pinned chats first, and use `isPinned`, `updatedAt`, and `id` as the pagination cursor. `RemoteStorage` sends `cursorPinned=true|false` with cursor requests.

For long chats, pass `{ saveLimit: 20 }` to send only the most recent messages. Partial saves include `X-Murm-Save-Mode: partial`; backends should merge those messages instead of replacing the full stored chat.

<h2 id="browser-support">Browser Support</h2>

Murm UI emits ES2018 JavaScript. Runtime support depends on streaming and storage APIs: `fetch`, `ReadableStream`, `TextDecoder`, `AbortController`, `crypto.getRandomValues`, and IndexedDB or custom storage.
