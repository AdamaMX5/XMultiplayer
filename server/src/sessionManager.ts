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
  // objectId -> raw spawn message, per session; replayed to late joiners so they see
  // proxies that were spawned before they connected (A2).
  private spawnsBySession = new Map<string, Map<string, string>>();
  // memberId -> the objectIds that member has spawned, so a disconnect can despawn them.
  private spawnsByMember = new Map<string, Set<string>>();
  // objectId -> the memberId that spawned it, so a single object (e.g. destroyed in
  // combat, A4) can be un-recorded without touching that member's OTHER spawns.
  private ownerByObjectId = new Map<string, string>();

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

  /** All members of a session, nobody excluded (e.g. an hp_state must reach the attacker too, not just "others"). */
  membersOf(sessionCode: string): SessionMember[] {
    const members = this.sessions.get(sessionCode);
    return members ? [...members.values()] : [];
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  /** Records that memberId spawned objectId in sessionCode, keeping the raw message for replay. */
  recordSpawn(sessionCode: string, memberId: string, objectId: string, raw: string): void {
    const bySession = this.spawnsBySession.get(sessionCode) ?? new Map<string, string>();
    bySession.set(objectId, raw);
    this.spawnsBySession.set(sessionCode, bySession);
    const owned = this.spawnsByMember.get(memberId) ?? new Set<string>();
    owned.add(objectId);
    this.spawnsByMember.set(memberId, owned);
    this.ownerByObjectId.set(objectId, memberId);
  }

  /** Raw spawn messages currently known for a session, e.g. to replay to a newly joined member. */
  spawnsOf(sessionCode: string): string[] {
    const bySession = this.spawnsBySession.get(sessionCode);
    return bySession ? [...bySession.values()] : [];
  }

  /** Forgets and returns the objectIds memberId had spawned in sessionCode (e.g. on disconnect, to despawn them). */
  takeSpawnedObjectIds(memberId: string, sessionCode: string): string[] {
    const owned = this.spawnsByMember.get(memberId);
    this.spawnsByMember.delete(memberId);
    if (!owned) return [];
    const bySession = this.spawnsBySession.get(sessionCode);
    for (const objectId of owned) {
      bySession?.delete(objectId);
      this.ownerByObjectId.delete(objectId);
    }
    return [...owned];
  }

  /**
   * Forgets a single spawned object's record (e.g. destroyed in combat, A4),
   * without touching the owning member's other spawns -- unlike
   * takeSpawnedObjectIds, which is for when the whole MEMBER leaves.
   */
  removeSpawn(sessionCode: string, objectId: string): void {
    this.spawnsBySession.get(sessionCode)?.delete(objectId);
    const memberId = this.ownerByObjectId.get(objectId);
    if (memberId) {
      this.spawnsByMember.get(memberId)?.delete(objectId);
      this.ownerByObjectId.delete(objectId);
    }
  }

  /**
   * The memberId that spawned objectId, if any (A4 ownership authority). server.ts
   * uses this to reject state_update/despawn/fire_event messages referencing an
   * objectId the sender does not actually own -- undefined means "nobody has
   * spawned this objectId", which callers must also treat as unauthorized (an
   * orphan reference), not as "anyone may claim it".
   */
  ownerOf(objectId: string): string | undefined {
    return this.ownerByObjectId.get(objectId);
  }

  /**
   * True if memberId already has an active spawn under some OTHER objectId (A4
   * spawn cap: one active spawn per member in v1). Re-spawning the SAME objectId
   * (a respawn) is always allowed and is not "other" for this check.
   */
  hasOtherActiveSpawn(memberId: string, objectId: string): boolean {
    const owned = this.spawnsByMember.get(memberId);
    if (!owned) return false;
    for (const ownedId of owned) {
      if (ownedId !== objectId) return true;
    }
    return false;
  }
}
