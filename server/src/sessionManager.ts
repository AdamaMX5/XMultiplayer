export interface SessionMember {
  id: string;
  playerName: string;
}

export interface LeaveResult {
  sessionCode: string;
  member: SessionMember;
}

/**
 * Minimal in-memory session/session-member bookkeeping. A "member" is one connected
 * WebSocket client; the relay server maps clientId -> SessionMember via this class
 * and keeps the actual sockets in its own map (see server.ts).
 */
export class SessionManager {
  private sessions = new Map<string, Map<string, SessionMember>>();
  private memberSession = new Map<string, string>();

  join(sessionCode: string, member: SessionMember): void {
    this.leave(member.id); // a client can only be in one session at a time
    const members = this.sessions.get(sessionCode) ?? new Map<string, SessionMember>();
    members.set(member.id, member);
    this.sessions.set(sessionCode, members);
    this.memberSession.set(member.id, sessionCode);
  }

  leave(memberId: string): LeaveResult | undefined {
    const sessionCode = this.memberSession.get(memberId);
    if (!sessionCode) return undefined;
    const members = this.sessions.get(sessionCode);
    const member = members?.get(memberId);
    members?.delete(memberId);
    if (members && members.size === 0) this.sessions.delete(sessionCode);
    this.memberSession.delete(memberId);
    return member ? { sessionCode, member } : undefined;
  }

  sessionCodeOf(memberId: string): string | undefined {
    return this.memberSession.get(memberId);
  }

  others(sessionCode: string, exceptMemberId: string): SessionMember[] {
    const members = this.sessions.get(sessionCode);
    if (!members) return [];
    return [...members.values()].filter((m) => m.id !== exceptMemberId);
  }

  sessionCount(): number {
    return this.sessions.size;
  }
}
