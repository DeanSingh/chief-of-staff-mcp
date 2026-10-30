# Security policy

chief-of-staff-mcp runs a local broker that holds every session's messages
and hands out per-peer credentials. Please report anything that lets a web
page, another local user or another peer read or send mail it shouldn't, or
otherwise get past the access control described in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#access-control).

## Reporting a vulnerability

Report privately through GitHub: on this repository's **Security** tab,
choose **Report a vulnerability**. Please don't open a public issue or pull
request for a vulnerability until a fix has shipped.

Include the version (commit), your OS and Bun version, and steps to
reproduce. You'll get an acknowledgement within a few days. Fixes land on
`main`; there are no maintained release branches.

## Scope

In scope: the broker, MCP server, hook and CLI in this repository.

Out of scope: processes running as your own user, which can read the
install secret by design; the third-party wake relay you configure; and
Claude Code or Claude Desktop themselves.
