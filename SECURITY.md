# Security

## What this plugin touches

- **Network:** only the cluster URLs in your config file, through `curl`. Nothing else is contacted.
- **Credentials:** read from the config file you point it at and passed to curl on stdin (`curl -K -`), never on argv, never logged, never shown in the pane or sent to the model. The agent-facing docs tell Claude not to print them.
- **Files:** reads and writes only under `~/.claude/mods/opensearch/` plus the session/config paths you pass explicitly.
- **Processes:** `curl` for requests; the first clipboard reader that works for `ctrl+v` (`pbpaste`, `wl-paste`, `xclip`, `powershell.exe`); `printenv` and your `passwordCommand` when configured.
- **Writes to the cluster:** only reads are sent (`writeGuard` in `hooks/lib.ts`). A write opens a prompt that shows the exact request; the person runs it once or unlocks the server for the session (never for `production`). Unlocks are in memory only, never read from disk.
- **Credentials:** a server that sends credentials asks the person once before its first request, keyed to its host and credential source, so an edited config can't send a secret to a new host.
- **Passwords:** from the config file, an environment variable (`passwordEnv`, read with `printenv`) or a command you configure (`passwordCommand`, run only after you approve the server).

## Reporting a vulnerability

Please open a private security advisory on GitHub (Security → Report a vulnerability) rather than a public issue.
