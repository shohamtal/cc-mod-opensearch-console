# Changelog

## 0.2.3

- **A session file with a JSON typo is never overwritten:** the pane says it can't save until you fix the file, instead of replacing your hand edit (and `lastRun`) with its own state.
- **One save at a time:** a timed save and a finished request no longer overlap and mistake each other's write for an outside change.
- **Windows:** `clip.exe` runs from `System32` by full path, like `cmd.exe` and `curl.exe`.

## 0.2.2

Fixes from an external review, all reproduced by tests:
- **A finished request, a cursor move or a server pick no longer overwrite a newer session file.** When the agent (or another editor) writes the session file in between, its query, cursor and server win, only `lastRun` (or your server pick) is merged in, and the pane reloads them. Changes are detected by modification time or content, and the pane's own writes are never mistaken for outside ones.
- **A request that finishes after switching to another session file** writes its response and `lastRun` to its own console, not the new one. A pending timed save is cancelled on the switch.
- **A server the session names before the config has it** is used as soon as it appears, instead of being replaced for good by the first server. Until then Run refuses ("server … isn't in servers.json") and never sends anywhere else.
- **Viewer clicks and the wheel** land on the line drawn after the viewer grew (server menu or prompt open). The wheel over the editor's bottom rows scrolls the editor while a menu is open.
- **Status line:** `lastRun` is written before the response file, so another pane on the same file never pairs a new body with the old status, and a new run with the same body still updates the status.
- **A press on a prompt** that an outside change already cancelled does nothing.
- **Copy reaches the clipboard:** copies go to `pbcopy` / `wl-copy` / `xclip` / `clip.exe` first, then the terminal's OSC 52 (off by default in iTerm2, missing in Terminal.app, where copying looked like it worked but left the clipboard empty).
- **ctrl+x copies before it cuts:** the copy rode on a separate post that the cut's edit replaced in the same frame, so the cut text was lost.
- **A console switch saves the old console's last edits** (typed within 250 ms of the switch) to the old file instead of dropping them.

## 0.2.1

- **Windows:** the mod's folder falls back to `%USERPROFILE%` when `HOME` is unset. `C:\…` and `\\server\share` paths are absolute, and backslashes work in `--filepath` / `--configfilepath`. The agent tool's "config must be inside the mod's folder" check compares paths with forward slashes. `passwordEnv` is read with `cmd /c set` instead of `printenv`, for plain variable names only. `cmd.exe` and `curl.exe` run from `System32` by full path. All of this applies only when `OS` is `Windows_NT`; macOS and Linux behave as before, where `\` is part of a file name.

## 0.2.0

- **Any number of servers** in a ▾ menu. A server is `{id, name, host, port, https, insecure, username, password | passwordEnv | passwordCommand, tag, path, headers, indices}`, and old `{name, url}` entries still work.
- **Writes ask first** instead of being refused. A prompt shows the exact request (method, URL, body). **Run once** sends exactly that; **Unlock for this session** (not for production) holds the unlock in memory only, and 🔓 locks again.
- **Credentials ask first:** a server that sends a password or headers needs your OK once, keyed to its host and credential source.
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
