# Changelog

## 0.1.0 (2026-10-19)

First public release.

- `/opensearch` toggles a Dev Tools-style console pane: request editor (colors, autocomplete, selection, format) and a foldable, searchable JSON response viewer
- Server switching from a local config file; credentials passed to curl on stdin
- One JSON state file per console (`--filepath`, `--configfilepath`) and the `mcp__opensearch-console__console` agent tool
- Read-only guard: whole-route allow-list, exact-path checks, bodies sent as `data-raw`
