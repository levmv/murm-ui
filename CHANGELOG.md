# Changelog

## 0.2.0 - 2026-06-28

### Changed

- Agent-run collapse now defaults to `agentRunCollapse: "machinery"`, keeping assistant prose visible while folding reasoning/tool work in place.

### Added

- Add `agentRunCollapse: "full" | "machinery"` and `AgentThinkingPlugin()` for agent-oriented reasoning previews.
- Add optional older-message pagination via opaque storage cursors; `RemoteStorage` and the feed can load history as the user scrolls upward.

### Fixed

- Preserve scroll and show status while loading older messages; keep live and completed reasoning/tool work inside the correct fold.

## 0.1.1 - 2026-06-14

### Fixed

- Cancel the SSE connection when the stream event callback throws.
- Isolate plugin hook errors so a faulty plugin can't break rendering, streaming, or submission.
- Fix a race where a save during auto-title generation could overwrite the new title.

## 0.1.0 - 2026-05-13

Initial release.
