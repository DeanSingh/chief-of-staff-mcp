/**
 * `bun cli.ts install-hooks`: the settings.json hooks, pointing at this
 * checkout's root entry files, and the /desktop-wake, /claim-cos and
 * /release-cos commands.
 */

import { chmodSync, mkdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The settings.json command that runs this hook from `dir`. Single-quoted so
 * no repo path can break out into the shell; "# claude-peers" marks the entry
 * as ours for install-hooks.
 */
export function hookCommand(dir: string): string {
  return `bun '${`${dir}/hook.ts`.replace(/'/g, `'\\''`)}' # claude-peers`;
}

/** The line that marks a ~/.claude/commands file as install-hooks' own. */
export const COMMAND_MARK =
  "<!-- # claude-peers: written by `bun cli.ts install-hooks`; re-run it after moving the repo. -->";

/**
 * The /desktop-wake slash command file, running the cli.ts in `dir`, or null
 * when `dir` holds a line break or backtick: the path is quoted into the
 * Markdown body, where either would garble the instruction.
 * Frontmatter values are JSON-quoted, which YAML reads as plain strings, so
 * no path can add a key. A ")" in the path would end the Bash(...) rule
 * early, so then the allowed-tools line is left out and Claude Code asks
 * before running the command instead.
 */
export function desktopWakeCommand(dir: string): string | null {
  if (/[\r\n`]/.test(dir)) return null;
  const run = `bun '${`${dir}/cli.ts`.replace(/'/g, `'\\''`)}' desktop-wake`;
  const frontmatter = [
    `description: ${JSON.stringify("Show or switch Claude Desktop agents' wake mode (active wakes them on new peer mail; passive costs nothing while idle)")}`,
    `argument-hint: ${JSON.stringify("[status | active | passive | default] [agent id or name] [--all]")}`,
    ...(run.includes(")") ? [] : [`allowed-tools: ${JSON.stringify(`Bash(${run}:*)`)}`]),
  ];
  return `---
${frontmatter.join("\n")}
---
${COMMAND_MARK}

Run \`${run} $ARGUMENTS\` and show the user its output. Do not run anything else.
If the command fails, show the error as-is.
`;
}

/**
 * The /claim-cos or /release-cos command file. The hook carries the command
 * out and blocks the prompt, so this body reaches the model only when the hook
 * didn't run. The model can't invoke it: a Skill call fires no hook, so it
 * would only ever report that nothing changed.
 */
export function cosCommand(release: boolean): string {
  const name = release ? "/release-cos" : "/claim-cos";
  const description = release
    ? "Stop this session being the claude-peers chief of staff"
    : "Make this session the claude-peers chief of staff";
  return `---
description: ${JSON.stringify(description)}
disable-model-invocation: true
---
${COMMAND_MARK}

The claude-peers hook carries out ${name} before it reaches you, so you are reading this only because the hook didn't run. Tell the user that nothing changed, and that \`bun cli.ts install-hooks\` installs the hook, or \`bun cli.ts cos\` in their own terminal names the chief of staff. Do nothing else.
`;
}

/** True when `text` is a command file install-hooks wrote, so re-running may replace it. */
export function isOurCommand(text: string): boolean {
  return text.split("\n").includes(COMMAND_MARK);
}

/**
 * The slash commands, user-wide so they work from any project. /desktop-wake
 * runs this checkout's cli.ts by absolute path, like the hook. A file of the
 * same name that isn't ours is left alone.
 */
async function installCommands(dir: string, root: string): Promise<void> {
  const commands: Array<[string, string | null]> = [
    ["desktop-wake", desktopWakeCommand(root)],
    ["claim-cos", cosCommand(false)],
    ["release-cos", cosCommand(true)],
  ];
  for (const [name, text] of commands) {
    const cmdPath = `${dir}/${name}.md`;
    const cmdFile = Bun.file(cmdPath);
    if (!text) {
      console.log(
        `Skipped ${cmdPath}: this checkout's path has a line break or backtick. Move the repo to use /${name}.`,
      );
    } else if ((await cmdFile.exists()) && !isOurCommand(await cmdFile.text())) {
      console.log(`Skipped ${cmdPath}: it exists and isn't from claude-peers.`);
    } else {
      mkdirSync(dir, { recursive: true });
      await Bun.write(cmdPath, text);
      console.log(`Installed /${name} in ${cmdPath}`);
    }
  }
}

/** The hook events hook.ts handles, in the order install-hooks reports them. */
const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd"];

/** `install-hooks`: install the hooks and /desktop-wake for the checkout at `root`. */
export async function installHooks(root: string): Promise<void> {
  // Registers hook.ts for SessionStart, so a resumed conversation reclaims its
  // peer id; for UserPromptSubmit, the unread-mail nudge and closing the
  // session's open requests; for Notification and Stop, the decision queue's
  // capture; and for SessionEnd, closing the session's requests (see hook.ts). The command is generated from this file's own
  // location, so re-run this after moving the repo. Our entry is recognised
  // by its trailing "# claude-peers" shell comment: re-running replaces it in
  // place instead of appending a duplicate, and anything else is untouched.
  const MARK = "# claude-peers";
  const flag = process.argv.indexOf("--settings");
  const path = flag > 0 ? process.argv[flag + 1]! : `${process.env.HOME}/.claude/settings.json`;
  const file = Bun.file(path);
  // Only the hooks we own are typed; everything else passes through untouched.
  type Hook = { command?: unknown; [k: string]: unknown };
  type Group = { hooks?: Hook[]; [k: string]: unknown };
  const settings: { hooks?: Record<string, Group[]>; [k: string]: unknown } = (await file.exists())
    ? await file.json()
    : {};
  const command = hookCommand(root);

  settings.hooks ??= {};
  for (const event of HOOK_EVENTS) {
    const groups: Group[] = (settings.hooks[event] ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !String(h.command ?? "").endsWith(MARK)) }))
      .filter((g) => g.hooks.length > 0);
    groups.push({ hooks: [{ type: "command", command, timeout: 1 }] });
    settings.hooks[event] = groups;
  }

  // Write a sibling temp file and rename it over the original, so a crash
  // mid-write can't leave Claude Code a truncated settings.json. Resolve
  // symlinks first (dotfile managers link this file), or the rename would
  // replace the link with a plain file. The temp file is created with the
  // original's permissions, never wider even for a moment: settings.json can
  // hold secrets in env and is often 0600. (chmod after too: umask can only
  // narrow the creation mode.)
  const exists = await file.exists();
  const real = exists ? realpathSync(path) : path;
  const tmp = `${real}.tmp-${process.pid}`;
  try {
    const mode = exists ? statSync(real).mode & 0o7777 : 0o644;
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode, flag: "wx" });
    chmodSync(tmp, mode);
    renameSync(tmp, real);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
  console.log(
    `Installed SessionStart, UserPromptSubmit, Notification, Stop and SessionEnd hooks in ${path}:\n  ${command}`,
  );

  await installCommands(`${dirname(path)}/commands`, root);
  return;
}
