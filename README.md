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
    ChatUI,
    OpenAIAdapter,
    IndexedDBAdapter,
    AttachmentPlugin,
    ThinkingPlugin,
    EditPlugin
} from "minimal-llm-chat";

const ui = new ChatUI({
    container: "#app", // The DOM element to mount into
    
    // 1. The Provider (Handles the AI stream)
    // You can use the built-in OpenAI adapter, or write your own for a custom backend.
    provider: new OpenAIAdapter(
        "YOUR_API_KEY", 
        "https://api.openai.com/v1/chat/completions", 
        "gpt-4o-mini"
    ),
    
    // 2. Storage (Handles chat history)
    // IndexedDBAdapter for local-only, or RemoteStorageAdapter for cloud saving.
    storage: new IndexedDBAdapter(),
    
    // 3. Plugins (Opt-in UI features)
    plugins: (chatApi) => [
        AttachmentPlugin(), // Adds file/image upload UI
        ThinkingPlugin(),   // Adds `<think>` accordion blocks (e.g., DeepSeek Reasoner)
        EditPlugin({ 
            onSave: (id, text) => chatApi.editAndResubmit(id, text) 
        }),
    ],
    
    // Optional: Syntax highlighting
    highlighter: (code, lang) => Prism.highlight(code, Prism.languages[lang], lang),
});
```
Note: You must provide your own HTML/CSS layout skeleton. See example/index.html for the standard layout template.

### 1. The Backend API Specification 
If a developer wants to build a backend for this UI, they only need to implement these endpoints. We will assume standard JWT/Token-based authentication (`Authorization: Bearer <token>`) or session cookies.

**1. Verify Auth / Get User**
*   **GET** `/api/auth/me`
*   **Response (200 OK):** `{ "id": "123", "name": "User" }`

**2. List All Chats (Metadata) - Cursor Paginated**
* **GET** `/api/chats?limit=20&cursor=1710629000000&cursorId=chat-5`
* `cursor` (timestamp) and `cursorId` (string ID) are optional. When present, they should point to the `updatedAt` and `id` of the last item from the previous page.
*  Chats are sorted by `updatedAt` descending.
*   **Response (200 OK):** 
    ```json
    [
      { "id": "chat-1", "title": "React vs Vue", "updatedAt": 1710629000000 },
      { "id": "chat-2", "title": "Explain Quantum Computing", "updatedAt": 1710628000000 }
    ]
    ```

**3. Get a Specific Chat (Full Messages)**
*   **GET** `/api/chats/:id`
*   **Response (200 OK):**
    ```json
    {
      "id": "chat-1",
      "title": "React vs Vue",
      "updatedAt": 1710629000000,
      "messages": [
        { "id": "msg-1", "role": "user", "content": "Hello" },
        { "id": "msg-2", "role": "assistant", "content": "Hi there!" }
      ]
    }
    ```

**4. Save / Update a Chat**
*   **PUT** `/api/chats/:id`
*   **Body:** Same JSON as the Get Specific Chat response.
*   **Response (200 OK):** `{ "success": true }`


**5. Delete a Chat**
*   **DELETE** `/api/chats/:id`
*   **Response (200 OK):** `{ "success": true }`

**6. Update Chat Metadata (Optional)**
*   **POST** `/api/chats/:id/meta`
*   **Description:** The UI calls this to update background data, such as when the LLM auto-generates a smart title.
*   **Body:** `{ "title": "A Smart Summary" }`
*   **Response (200 OK):** `{ "success": true }`

**7. Generate Smart Title (Optional)**
*   **POST** `/api/chats/:id/title`
*   **Description:** The UI calls this after the first message exchange. The backend prompts the LLM to summarize the chat and returns the title.
*   **Response (200 OK):** `{ "title": "A Smart Summary" }`


### Browser Support

This library is designed with a strict **ES2017 baseline**, meaning it works flawlessly on browsers dating back to roughly ~2017 (Chrome 55+, Safari 10.1+, Firefox 52+). 

We prioritize graceful degradation:
* Modern CSS features like `field-sizing: content` are feature-detected; older browsers gracefully fall back to JavaScript-driven auto-resizing.
* UI enhancements like `ResizeObserver` are conditionally applied without breaking core chat functionality on legacy devices.