---
description: Show or switch Claude Desktop agents' wake mode (active wakes them on new peer mail; passive costs nothing while idle)
argument-hint: "[status | active | passive | default] [agent id or name] [--all]"
allowed-tools: Bash(bun cli.ts desktop-wake:*)
---

Run `bun cli.ts desktop-wake $ARGUMENTS` from this repository and show the user its output. Do not run anything else.
If the command fails, show the error as-is.
