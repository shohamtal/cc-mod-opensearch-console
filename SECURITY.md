# Security

## What this plugin touches

- **Network:** only the cluster URLs in your config file, through `curl`. Nothing else is contacted.
- **Credentials:** read from the config file you point it at and passed to curl on stdin (`curl -K -`), never on argv, never logged, never shown in the pane or sent to the model. The agent-facing docs tell Claude not to print them.
- **Files:** reads and writes only under `~/.claude/mods/opensearch/` plus the session/config paths you pass explicitly.
- **Processes:** `curl` for requests; the first clipboard reader that works for `ctrl+v` (`pbpaste`, `wl-paste`, `xclip`, `powershell.exe`); `printenv` and your `passwordCommand` when configured.
- **Writes to the cluster:** locked per server by default (`allowWrites`). On a locked server an allow-list (`writeGuard` in `hooks/lib.ts`) lets only reads through, and a write asks the person to unlock it in `servers.json`. Use a read-only cluster user where you can.
- **Passwords:** from the config file, an environment variable (`passwordEnv`, read with `printenv`) or a command you configure (`passwordCommand`).

## Reporting a vulnerability

Please open a private security advisory on GitHub (Security → Report a vulnerability) rather than a public issue.
