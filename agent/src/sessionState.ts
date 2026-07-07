import type { ProtocolMessage } from "@xmultiplayer/protocol";

/**
 * Tracks what this agent needs to resend after a WebSocket reconnect: the last
 * outbound (local game -> pipe -> agent -> server) session-join line, and the
 * last outbound spawn line for the agent's OWN ship, if any (A5 "Agent-
 * dynamische Session"). A WS reconnect gets a brand-new clientId server-side,
 * which has forgotten this connection's session membership and any spawn it had
 * recorded (server/src/sessionManager.ts has no notion of "the same player
 * reconnected", only "a new client joined") -- without resending these, the
 * agent would sit connected but silently absent from its own session until the
 * local game happened to resend a join/spawn on its own initiative, which
 * nothing prompts it to do.
 */
export class SessionState {
  private joinLine: string | undefined;
  private ownSpawnLine: string | undefined;
  private ownObjectId: string | undefined;

  /** Call for every outbound message (from the local game, before it's sent to the relay) to keep the resend state current. */
  observeOutbound(msg: ProtocolMessage, raw: string): void {
    if (msg.type === "session" && msg.action === "join") {
      this.joinLine = raw;
      return;
    }
    if (msg.type === "session" && msg.action === "leave") {
      // Leaving a session implies our ship's context there ends too; clear both
      // rather than risk resending a stale spawn into a session we deliberately left.
      this.joinLine = undefined;
      this.ownSpawnLine = undefined;
      this.ownObjectId = undefined;
      return;
    }
    if (msg.type === "spawn") {
      this.ownSpawnLine = raw;
      this.ownObjectId = msg.objectId;
      return;
    }
    if (msg.type === "despawn" && msg.objectId === this.ownObjectId) {
      this.ownSpawnLine = undefined;
      this.ownObjectId = undefined;
    }
  }

  /** Lines to resend after a reconnect, in order (join before spawn -- a spawn outside a session is meaningless). Empty if there's nothing to restore. */
  resendLines(): string[] {
    const lines: string[] = [];
    if (this.joinLine) lines.push(this.joinLine);
    if (this.ownSpawnLine) lines.push(this.ownSpawnLine);
    return lines;
  }
}
