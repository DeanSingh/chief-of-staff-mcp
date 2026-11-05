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
  wake_topic?: string; // Desktop only: the secret relay topic this identity is woken on (absent when the relay is off)
  wake_url?: string; // Desktop only: <relay>/<topic> as the broker publishes it; the server builds the Monitor copy from this
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

/** RFC 5424 severities, the same names MCP logging uses. */
export type EventLevel = "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency";

/** In severity order, least severe first. */
export const EVENT_LEVELS: readonly EventLevel[] = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
];

export type RequestState = "pending" | "escalated" | "answered" | "canceled";

export type AnsweredVia = "cos" | "human" | "terminal";

/** Who an event or request is about: a registered peer, a session key, or both. */
export interface Subject {
  peer_id?: PeerId;
  session_key?: string;
}

/** A request or event row as the digest shows it. A Desktop session_key is never included. */
export interface DigestRow {
  id: string | number;
  peer_id: PeerId | null;
  session_key: string | null;
}

export interface DigestRequest extends DigestRow {
  id: string;
  question: string;
  waiting_for: string;
  urgency: string;
  source: string;
  created_at: string;
}

export interface DigestEscalated extends DigestRequest {
  escalated_at: string | null;
  escalation_note: string | null;
}

export interface DigestEvent extends DigestRow {
  id: number;
  level: EventLevel;
  source: string;
  logger: string | null;
  message: string;
  created_at: string;
}

export interface DigestPeer {
  id: PeerId;
  session_key: string | null;
  summary: string;
  cwd: string;
  peer_type: PeerType;
  last_seen: string;
}

/** Everything a chief of staff needs to decide what to look at. Data, not instructions. */
export interface Digest {
  ok: true;
  peers: DigestPeer[];
  pending: DigestRequest[];
  escalated: DigestEscalated[];
  events: DigestEvent[];
  cursor: { from: number; to: number; truncated: boolean };
}
