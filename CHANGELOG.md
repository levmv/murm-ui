# Changelog

## 0.1.1 - 2026-06-14

### Fixed

- Cancel the SSE connection when the stream event callback throws.
- Isolate plugin hook errors so a faulty plugin can't break rendering, streaming, or submission.
- Fix a race where a save during auto-title generation could overwrite the new title.

## 0.1.0 - 2026-05-13

Initial release.
