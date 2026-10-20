# Changelog

## 0.2.0

- **Any number of servers** in a ▾ menu. A server is `{id, name, host, port, https, insecure, username, password | passwordEnv | passwordCommand, tag, allowWrites, path, headers, indices}`, and old `{name, url}` entries still work.
- **Writes are locked per server** (`allowWrites`, off by default). A write on a locked server asks to unlock it instead of being refused, and 🔓 locks it again.
- **Editor:** undo/redo (`alt+z` / `alt+y`, or ↶ ↷), and the agent's injected text can be undone too. Autocomplete covers methods, endpoints, `_cat/` and `_cluster/` paths, query parameters and query DSL keys.
- **Fixes:**
  - Control characters in pasted or injected text no longer break the editor.
  - Server tags replace guessing production from the name.
  - Paste works on Linux and Windows.
  - Marketplace and control-character warnings from the catalogue scan are cleared.
- **Repo:** a contributing guide, plus PR and issue templates.

## 0.1.0 (2026-10-19)

First public release.

- `/opensearch` toggles a Dev Tools-style console pane: request editor (colors, autocomplete, selection, format) and a foldable, searchable JSON response viewer
- Server switching from a local config file; credentials passed to curl on stdin
- One JSON state file per console (`--filepath`, `--configfilepath`) and the `mcp__opensearch-console__console` agent tool
- Read-only guard: whole-route allow-list, exact-path checks, bodies sent as `data-raw`
