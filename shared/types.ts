// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export type PeerType = "cli" | "desktop";

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  peer_type: PeerType;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  peer_type: PeerType;
  /**
   * Desktop only: the session's claimed peer_session token. The broker keys
   * the peer on it so the SAME peer id is returned no matter which MCP
   * server process (Desktop spawns several, and respawns them on bridge
   * reconnects) is serving the call.
   */
  session_token?: string;
  /**
   * CLI only: Claude Code's own session id (process.env.CLAUDE_CODE_SESSION_ID).
   * Stable across --resume and across crash+restart, so the broker keys the
   * peer on it and the same id comes back after the process dies. Absent when
   * the server runs standalone or on a Claude Code without the variable, in
   * which case registration falls back to pid matching.
   */
  session_key?: string;
}

export interface RegisterResponse {
  id: PeerId;
  restored_summary?: string; // Set when a cached summary from a previous session was restored
  /** This peer's credential: send it as the PEER_HEADER on routes that act as this peer. */
  peer_secret?: string;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}

export interface AckMessagesRequest {
  /** The recipient acking; only its own messages are marked delivered. */
  id: PeerId;
  message_ids: number[];
}

/**
 * Posted by the SessionStart hook with the LIVE session id, which the MCP
 * server cannot see after /clear or an in-session /resume (its env var was
 * fixed at spawn). `pid` is the Claude Code process the hook ran under.
 */
export interface SessionStartRequest {
  session_key: string;
  pid: number;
  source: string;
}

export type SessionStartResponse =
  | { ok: true; peer_id: PeerId; action: "noop" | "mapped" | "rekeyed" }
  | { ok: false; reason: "no_live_peer" | "conflict" | "bad_request" };
