/**
 * Broker settings read from the environment: port, database path and wake relay.
 */

export const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
export const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
// Cloud Desktop/Cowork sessions can't reach this loopback broker, so they are
// woken through an outbound pub/sub relay instead: each desktop identity gets a
// secret topic, and a send POSTs the bare word "wake" to it. Message content
// never leaves the machine. "off" disables the relay.
// Nothing is published unless the wake mode (below) is active: the relay is a
// third party that sees when each desktop identity gets mail. It must be
// https, except on this machine, and URL-safe characters only: it is pasted
// into the shell command every agent's Monitor runs.
export const WAKE_RELAY_ENV = process.env.CLAUDE_PEERS_WAKE_RELAY;
export const WAKE_RELAY = (WAKE_RELAY_ENV ?? "https://ntfy.sh").replace(/\/+$/, "");
export const WAKE_ON =
  /^[A-Za-z0-9.:/_-]+$/.test(WAKE_RELAY) && /^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(WAKE_RELAY);
if (WAKE_RELAY !== "off" && !WAKE_ON) {
  console.error(
    "[claude-peers broker] CLAUDE_PEERS_WAKE_RELAY must be https:// (or http:// on 127.0.0.1/localhost) and use only [A-Za-z0-9.:/_-]; wake relay disabled",
  );
}
export const WAKE_COALESCE_MS = Number(process.env.CLAUDE_PEERS_WAKE_COALESCE_MS) || 10_000;
