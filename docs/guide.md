# Murm UI Documentation

Use `ChatUI` for a ready-made chat, or use `ChatView`, `Composer` and `Sidebar` independently with your own backend.

## Contents

- [Install](#install)
- [ChatUI](#chatui)
- [ChatView and Composer](#chatview-and-composer)
- [Sidebar](#sidebar)
- [Plugins](#plugins)
- [Appearance](#appearance)
- [Providers](#providers)
- [Storage](#storage)
- [Migration from 0.2.0](#migration-from-020)
- [Browser Support](#browser-support)

## Install

```sh
npm install murm-ui
```

The examples use `murm-ui/with-css`, which includes the core styles. See [Appearance](#appearance) for individual imports.

## ChatUI

`ChatUI` manages requests, history, input and navigation. Start with the [HTML shell](chat-shell.html); its class names connect the library to your markup. Button contents, icons and the optional chat title can be changed.

```ts
import { ChatUI, IndexedDBStorage, OpenAIProvider } from "murm-ui/with-css";
import { CopyPlugin } from "murm-ui/plugins/copy";
import { EditPlugin } from "murm-ui/plugins/edit";

const ui = new ChatUI({
  container: ".mur-app",
  provider: new OpenAIProvider("", "/api/chat/completions", "your-model"),
  storage: new IndexedDBStorage(),
  plugins: (engine) => [
    CopyPlugin(),
    EditPlugin({ onSave: (id, text) => engine.editAndResubmit(id, text) }),
  ],
});
```

`ui.engine` exposes message submission, cancellation and session management. Use `ui.destroy()` when removing the chat.

| Option | Purpose |
| --- | --- |
| `fullscreen: false` | Embed the chat in a container with a bounded height |
| `enableSidebar: false` | Use your own conversation navigation |
| `routing: false` | Disable URL routing |
| `updateWindowTitle` | Update the browser title; accepts `true` or a title formatter |
| `sidebarMenu(defaults, context)` | Filter or extend session menu actions |
| `highlighter` | Add syntax highlighting to code blocks |

## ChatView and Composer

`ChatView` displays application-owned conversations. `Composer` handles input and drafts. Give each a container; they create their own markup. The transcript host needs a bounded height, such as `height: 70vh`.

```ts
import { ChatView, Composer } from "murm-ui/with-css";

const view = new ChatView({ container: "#transcript" });
const composer = new Composer({
  container: "#input",
  onSubmit: (command) => backend.send(command),
  onStop: ({ conversationId }) => backend.stop(conversationId),
});

view.setConversation({ id: "chat-1", messages: [] });
composer.setConversation("chat-1");
```

Here `backend` is your application's API adapter. `onSubmit` receives `{ conversationId, clientRequestId, text, blocks, signal }`. Resolve when input is accepted, throw to show an error, or return `false` to keep the draft. The application supplies accepted messages through `setConversation` or `apply`.

### Messages and streaming

`setConversation({ id, messages })` replaces the displayed history without saving or submitting it. Use `apply` for incremental updates:

```ts
view.apply({
  conversationId: "chat-1",
  changes: [{
    type: "message.put",
    message: {
      id: "answer", role: "assistant", status: "streaming",
      blocks: [{ id: "body", type: "text", text: "" }],
    },
  }],
});

// As text arrives:
view.apply({
  conversationId: "chat-1",
  changes: [{ type: "text.append", messageId: "answer", blockId: "body", delta: "Hello" }],
});
```

| Change | Effect |
| --- | --- |
| `message.put` / `message.remove` | Insert, replace or remove a message; `beforeId` controls insertion order |
| `block.put` / `block.remove` | Insert, replace or remove a block within a message |
| `text.append` | Append to an existing text or reasoning block |
| `tool.update` | Append tool arguments with `argsDelta`, or update its name/status |
| `message.state` | Set status, error, usage or timestamp; use `status: "complete"` when a response ends |

Message IDs are unique within a conversation; block IDs are unique within a message. Updates for another conversation return `false`; invalid batches throw without partially applying changes. Your adapter handles event ordering and reconnects: applying a text delta twice appends it twice.

`view.state` exposes the current read-only state. To share state between views, pass a `ConversationModel` as the `conversation` option.

For older history, load a page in `onReachTop`, update the indicator with `setOlderMessagesState(hasMore, loading)`, and add messages with `prependMessages(conversationId, messages)`. Discard stale page responses after switching conversations. `setLoading` controls the transcript loading state; `setError(message)` shows an error and `setError(null)` clears it.

### Input and drafts

Switch both components when changing conversations. Composer keeps text and attachment drafts per conversation; successful submission clears the submitted draft while preserving later edits.

Use `composer.setCapabilities({ canSubmit, canEdit, canStop })` to control input. `canEdit` defaults to `canSubmit`; set it to `true` to allow drafting while submission is unavailable. `canStop` enables Stop when an `onStop` callback is supplied. Enter submits; the Stop button requests cancellation.

`composer.getDraft(id?)` and `setDraft(text)` read and restore text. `view.scrollToLatest()` scrolls to the latest message; `composer.focus()` focuses input. `view.setCanAct(false)` disables mutating message actions.

Destroy components when removing them. Composer cancels pending uploads and stops waiting for submission acceptance; this does not stop server work.

## Sidebar

`Sidebar` displays an application-owned conversation list inside a `.mur-app` shell. Pass actions as callbacks and refresh the list with `update` after server changes:

```ts
import { Sidebar } from "murm-ui/with-css";

const sidebar = new Sidebar({
  container: "#app",
  header: "Chats",
  onSelect: selectConversation,
  onNew: createConversation,
  onRename: renameConversation,
  onDelete: deleteConversation,
});
sidebar.update({
  sessions: [{ id: "chat-1", title: "Research" }],
  activeId: "chat-1",
  hasMore: false,
  loading: false,
});
```

The callbacks belong to your application. Actions appear when their callbacks are supplied. `onPin` enables pinning; supply pinned sessions first. `onLoadMore` handles pagination, and `getHref` adds conversation links. `menu` customizes actions; `confirmDelete` replaces browser confirmation.

Use `header`, `footer` and `links` for additional panel content. `open()`, `close()` and `setActive(id)` control the panel; `destroy()` removes it. `reuseMarkup: true` adopts an existing sidebar from the [HTML shell](chat-shell.html).

## Plugins

Pass an array to `ChatView.plugins` or `Composer.plugins`, or an `(engine) => plugins` factory to `ChatUI.plugins`. Each plugin is imported from `murm-ui/plugins/<name>` and includes its own CSS.

| Import | Plugin | Purpose |
| --- | --- | --- |
| `attachment` | `AttachmentPlugin` | File picking, paste/drop, uploads and previews |
| `tools` | `ToolsPlugin` | Tool calls and their results |
| `thinking` | `ThinkingPlugin` | Expandable reasoning |
| `agent-thinking` | `AgentThinkingPlugin` | Inline reasoning preview; an alternative to `ThinkingPlugin` |
| `copy` | `CopyPlugin` | Copy message text |
| `edit` | `EditPlugin` | Edit user messages through an `onSave` callback |
| `settings` | `SettingsPlugin` | Provider settings for `ChatUI` |

`tools()`, `thinking()` and `agentThinking()` are aliases for their named plugin factories. `EditPlugin.onSave` resolves when the edit is accepted; `false` or rejection keeps the editor open.

Agent runs default to `agentRunCollapse: "machinery"`: technical steps fold under “Worked” while assistant prose stays visible. `"full"` keeps only the final reply outside the fold. For a compact tool view, use `ToolsPlugin({ details: false })` and application-supplied tool summaries; `showReasoning: false` hides reasoning in `ChatView`.

### Attachments

`AttachmentPlugin()` works with `Composer` and `ChatUI`. By default it reads local images as data URLs and text files as text. For uploads, supply `onAttach({ conversationId, file, signal })`, returning a `ContentBlock`. `maxFileSize` defaults to 20 MiB; `previewContainer` can host previews elsewhere in your layout.

Pending uploads and failed attachments block submission until resolved or removed. `attachFiles(files)`, `removeAttachment(id)`, `getDraft(id?)` and `setDraft(blocks, id?)` let the application manage the queue.

### Custom plugins

A display plugin provides `renderers: [{ matches, mount }]`. `mount(container)` creates the block's controls and returns `update(block, context)` and `destroy()`. Update existing controls in place; release listeners, timers and pending asynchronous output on destruction. See the [card example](https://github.com/levmv/murm-ui/blob/main/example/next/card.ts).

The first matching renderer owns a block. Text uses built-in Markdown when no plugin claims it. The context includes the message, transcript, labels, generating state and `canAct`. `context.dispatch(action, payload)` sends an addressed action to `ChatView.onAction`; this route is not exposed by `ChatUI`.

`getActionButtons(message, labels)` adds message actions. Keep action IDs stable and derive buttons from the current message; definitions refresh for completed-message changes and when streaming finishes. Set `mutates: false` for actions such as copying that remain available in read-only views.

Input plugins implement `mountComposer(context)`. The returned extension can provide `hasContent`, `isBlocked` and `collect()`, plus `destroy()`. `collect` returns `{ blocks, accept }`; clear the captured draft in `accept`. Call `context.changed()` when plugin input changes. Create a separate plugin instance for each composer.

`ChatUI` also runs `onMount` and `beforeSubmit` hooks for engine integration and request preparation. Standalone components only run their relevant display/input hooks.

## Appearance

`murm-ui/with-css` includes all core styles. The root `murm-ui` import and component entrypoints do not import CSS; for selective imports use:

| Component | Styles under `murm-ui/styles/` |
| --- | --- |
| `ChatView` | `base.css`, `feed.css`, `view.css` |
| `Composer` | `base.css`, `input.css`, `composer.css` |
| `Sidebar` | `base.css`, `sidebar.css`, `dropdown.css` |

Set `data-theme="light"` or `data-theme="dark"` on the host, or omit it to follow the system theme. Override inherited `--mur-*` variables to customize colors and sizing. `labels` customizes component text and accessible labels.

`ChatView` is embedded by default; `ChatUI` is fullscreen by default. Set `fullscreen` explicitly to change this. `ChatView.emptyState` accepts text or an element. To adopt existing markup, use `ChatView.reuseMarkup` or `Composer.form`.

### Syntax highlighting

Both `ChatView` and `ChatUI` accept an optional `highlighter`:

```ts
import { highlight } from "murm-ui/highlighter";
import "murm-ui/highlighter/theme.css";

const view = new ChatView({ container: "#transcript", highlighter: highlight });
```

Without it, code blocks still have language labels and copy buttons. A custom `(code, language) => html` function may return a string or promise; its output must escape user code and contain only trusted markup.

For custom grammars, `createHighlighter` from `murm-ui/highlighter/chat` accepts a `loadLanguage` callback returning a language definition. `murm-ui/highlighter/core` provides an empty registry; the bundled grammars use the Prism-compatible format.

## Providers

`OpenAIProvider(apiKey, endpoint, model)` works with OpenAI-compatible chat completion endpoints. Point it at your backend proxy or local model server; user-supplied keys can also be passed directly.

A custom provider implements:

```ts
interface ChatProvider {
  streamChat(
    request: ChatStreamRequest,
    onChange: (changes: ConversationChange[]) => void,
  ): Promise<void>;
  generateTitle?(request: ChatRequest): Promise<string>;
}
```

The request contains `messages`, `instructions`, `tools`, generation `options` and an abort `signal`. For streaming, the engine creates an empty assistant message with `request.messageId`. Add blocks with `block.put`, then send deltas. Additional messages use their own IDs and `request.runId`.

Use `message.state` for individual completion and usage. Resolving `streamChat` completes remaining streamed messages; rejecting it reports failure. Honor `request.signal` for cancellation. Providers translate instructions, tools and generation options to their model API's format.

## Storage

`IndexedDBStorage` persists chats in the browser. `RemoteStorage("/api", getToken)` uses the endpoints below and sends a bearer token when `getToken` returns one. Custom adapters implement `ChatStorage`.

| Request | Response / behavior |
| --- | --- |
| `GET /api/chats?limit=20` | `{ items: ChatSessionMeta[], hasMore: boolean }` |
| `GET /api/chats/:id` | `ChatSession`; 404 for a missing chat |
| `GET /api/chats/:id?before=<cursor>&limit=<n>` | `{ messages, hasMore, nextOlderMessagesCursor? }` |
| `PUT /api/chats/:id` | Save a `ChatSession` request body |
| `POST /api/chats/:id/meta` | Apply metadata such as `title` or `isPinned` |
| `DELETE /api/chats/:id` | Delete the chat |

Write requests accept any successful HTTP status. A `ChatSession` contains `id`, `title`, `updatedAt`, `messages`, optional `isPinned` and history pagination fields.

For paginated history, return `hasMoreMessages` and `nextOlderMessagesCursor` with the chat. Older pages are ordered oldest-first and require a next cursor while `hasMore` is true. Cursors are independent of message IDs.

Sort the chat list by pinned first, then `updatedAt` descending, then ID descending. The next list request supplies `cursorPinned`, `cursor` and `cursorId` from the previous page's last item.

**Partial saves:** requests include `X-Murm-Save-Mode: partial` while older messages remain unloaded or `{ saveLimit }` truncates the payload. Preserve the stored prefix before the first incoming message, then replace the tail, removing omitted messages from that tail. Determine this boundary by stored transcript order, never by comparing IDs. If the first ID is unknown, the backend must establish the boundary explicitly. Without the header, replace the complete chat. Custom storage must likewise preserve an unloaded prefix when `hasMoreMessages` is true.

## Migration from 0.2.0

`ChatUI` keeps its HTML shell and saved message format. The main API changes are:

- Individual CSS imports now also need `view.css` and `composer.css`; `murm-ui/with-css` includes them.
- Providers emit `ConversationChange` batches instead of `StreamEvent`. Use the supplied response ID, create blocks explicitly and resolve the promise to finish. `engine.conversation` replaces `subscribeHot` for message updates.
- Block plugins replace `onBlockRender` with `renderers` and their `mount`/`update`/`destroy` lifecycle.
- Input plugins replace the old input hooks with `mountComposer` and `collect`; clear submitted blocks in `accept`. Request transformations still use `beforeSubmit`.
- Attachments replace `uploadFile`/`fileHandlers` with `onAttach`, and preview selectors with `previewContainer`.
- Action definitions refresh when messages change; retain stable action IDs. Enter submits; stopping uses the Stop button.

## Browser Support

The package emits ES2018 JavaScript and uses modern browser APIs, including fetch streaming, `AbortController`, `Object.hasOwn` and `Element.replaceChildren`. Clipboard, resize observation and automatic sidebar pagination are used when available. IndexedDB is required only for `IndexedDBStorage`.
