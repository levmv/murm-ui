# Murm UI

A zero-framework, vanilla TypeScript chat interface for LLMs. 

Built for developers who need a functional chat UI without framework overhead. No React, no virtual DOM, no build pipeline complexity—just a small, composable library that handles chat state, rendering, and user interaction.

### Key Features
- **Minimal dependencies:** Only `marked` for markdown parsing. Everything else is standard Web APIs.
- **Simple build:** Single-command bundling with esbuild. No transpilation config required.
- **Efficient rendering**: Reference-based DOM updates and throttled markdown parsing to handle streaming responses without layout thrashing.
- **Highly Modular:** Bring your own backend, bring your own AI provider, and only load the UI plugins you actually need.

---

### Usage

The UI is heavily decoupled. You assemble the chat by passing in a **Provider** (how it talks to the AI), **Storage** (how it saves history), and **Plugins** (extra UI features).

Here is a complete example:

```typescript
import {
	AttachmentPlugin,
	ChatUI,
	CopyPlugin,
	EditPlugin,
	IndexedDBStorage,
	OpenAIProvider,
	ThinkingPlugin,
} from "murm-ui";

const ui = new ChatUI({
	container: "#app",
	provider: new OpenAIProvider("YOUR_API_KEY", "https://api.openai.com/v1/chat/completions", "gpt-4o-mini"),
	storage: new IndexedDBStorage(),
	plugins: (chatApi) => [
		AttachmentPlugin(),
		ThinkingPlugin(),
		CopyPlugin(),
		EditPlugin({
			onSave: (id, text) => chatApi.editAndResubmit(id, text),
		}),
	],
	highlighter: (code, lang) => Prism.highlight(code, Prism.languages[lang], lang),
});
```

The package entry imports the library CSS for bundlers that support CSS imports. The CSS assets are also exported for explicit use:

```typescript
import "murm-ui/styles/base.css";
import "murm-ui/styles/sidebar.css";
import "murm-ui/styles/input.css";
import "murm-ui/styles/feed.css";
import "murm-ui/plugins/attachment/attachment.css";
import "murm-ui/plugins/edit/edit.css";
import "murm-ui/plugins/settings/settings.css";
import "murm-ui/plugins/thinking/thinking.css";
```

You provide the HTML skeleton. See `example/index.html` for the standard class names expected by `ChatUI`.

Theme tokens are scoped to `.mur-app` and use the `--mur-*` prefix. Set `data-theme="light"` or `data-theme="dark"` on `.mur-app` for an explicit theme, or omit `data-theme` to follow the user's `prefers-color-scheme` setting.

### Remote Storage API

`RemoteStorage` expects these endpoints. It sends `Authorization: Bearer <token>` when the token callback returns a value.

**1. List Chats - Cursor Paginated**
* **GET** `/api/chats?limit=20&cursor=1710629000000&cursorId=chat-5`
* `cursor` (timestamp) and `cursorId` (string ID) are optional. When present, they should point to the `updatedAt` and `id` of the last item from the previous page.
*  Chats are sorted by `updatedAt` descending.
*   **Response (200 OK):** 
    ```json
    {
      "items": [
        { "id": "chat-1", "title": "React vs Vue", "updatedAt": 1710629000000 },
        { "id": "chat-2", "title": "Explain Quantum Computing", "updatedAt": 1710628000000 }
      ],
      "hasMore": false
    }
    ```

**2. Get A Chat**
*   **GET** `/api/chats/:id`
*   **Response (200 OK):**
    ```json
    {
      "id": "chat-1",
      "title": "React vs Vue",
      "updatedAt": 1710629000000,
      "messages": [
        {
          "id": "msg-1",
          "role": "user",
          "blocks": [{ "id": "text-1", "type": "text", "text": "Hello" }]
        },
        {
          "id": "msg-2",
          "role": "assistant",
          "blocks": [{ "id": "text-2", "type": "text", "text": "Hi there!" }]
        }
      ]
    }
    ```

**3. Save A Chat**
*   **PUT** `/api/chats/:id`
*   **Body:** Same JSON shape as the Get A Chat response.
*   **Response (200 OK):** `{ "success": true }`


**4. Delete A Chat**
*   **DELETE** `/api/chats/:id`
*   **Response (200 OK):** `{ "success": true }`

**5. Update Chat Metadata**
*   **POST** `/api/chats/:id/meta`
*   **Description:** The UI calls this to update background data, such as when the LLM auto-generates a smart title.
*   **Body:** `{ "title": "A Smart Summary" }`
*   **Response (200 OK):** `{ "success": true }`

### Browser Support

This library emits conservative **ES2018** JavaScript, but its real browser baseline is determined by the Web APIs required for streaming chat.

Supported runtime baseline:
* Chrome 66+
* Firefox 65+
* Safari 12.1+

Required browser APIs include `fetch`, streaming `Response.body`, `ReadableStream.getReader`, `TextDecoder`, `AbortController`, `crypto.getRandomValues`, and either IndexedDB or a custom storage implementation.

We prioritize graceful degradation for optional enhancements:
* Clipboard API support enables copy buttons when available.
* `ResizeObserver` improves sticky scrolling when available.
* `IntersectionObserver` enables automatic sidebar pagination when available.
* CSS features like `:has` and `field-sizing: content` are progressive enhancements; older browsers keep the core chat experience.
