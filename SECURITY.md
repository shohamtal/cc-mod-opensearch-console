# Security

## What this plugin touches

- **Network:** only the cluster URLs in your config file, through `curl`. Nothing else is contacted.
- **Credentials:** read from the config file you point it at and passed to curl on stdin (`curl -K -`), never on argv, never logged, never shown in the pane or sent to the model. The agent-facing docs tell Claude not to print them.
- **Files:** reads and writes only under `~/.claude/mods/opensearch/` plus the session/config paths you pass explicitly.
- **Processes:** `curl` for requests, `pbpaste` for `ctrl+v`.
- **Writes to the cluster:** refused by an allow-list (`writeGuard` in `hooks/lib.ts`); see the README's *Read-only* section. Use a read-only cluster user as well.

## Reporting a vulnerability

Please open a private security advisory on GitHub (Security → Report a vulnerability) rather than a public issue.
