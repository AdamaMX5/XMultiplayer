import type { SpawnCategory } from "@xmultiplayer/protocol";

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
  // objectId -> its SpawnMessage.category (C3), defaulted to "player" by recordSpawn
  // when the sender omitted it (A1-C2 compatibility). Kept as its own parallel map,
  // same idiom as ownerByObjectId, rather than folding category into the raw spawn
  // string -- npcSpawnCount() below needs to filter spawnsByMember by category
  // without re-parsing every member's raw spawn line on every spawn attempt.
  private categoryByObjectId = new Map<string, SpawnCategory>();

  /**
   * A client can only be in one session at a time, so joining calls leave()
   * first. Returns whatever leave() returned (undefined if the member wasn't in
   * any session before), so the caller (server.ts's joinSession) can run the
   * SAME spawn/HP cleanup a disconnect would (takeSpawnedObjectIds + despawn
   * broadcasts + hp.remove) for the OLD session -- this class only tracks state,
   * it doesn't own hp.remove or the sockets needed to broadcast, so it can't do
   * that cleanup itself. Before this fix (A5 review requirement), a session
   * switch left the old session's spawn/HP records as permanent ghosts: leave()
   * only ever cleaned up session MEMBERSHIP (this.sessions/memberSession), never
   * spawnsBySession/spawnsByMember/ownerByObjectId/the HP tracker. That was a
   * latent, undetected bug through A1-A4 because nothing ever actually called
   * join() twice for the same member with real spawns in between -- A5's
   * presence-based drop-in (walking between sectors triggers a real session
   * switch) is what turns it into a real, everyday occurrence instead of a
   * theoretical one.
   */
  join(sessionCode: string, member: SessionMember): LeaveResult | undefined {
    const previous = this.leave(member.id);
    const members = this.sessions.get(sessionCode) ?? new Map<string, SessionMember>();
    members.set(member.id, member);
    this.sessions.set(sessionCode, members);
    this.memberSession.set(member.id, sessionCode);
    return previous;
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

  /** A single member of a session by id, e.g. to look up a display name for the kill-feed (A5). */
  memberOf(sessionCode: string, memberId: string): SessionMember | undefined {
    return this.sessions.get(sessionCode)?.get(memberId);
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  /** True if sessionCode already has at least one member (A5 max-sessions enforcement: joining an EXISTING session never counts as "creating a new one"). */
  hasSession(sessionCode: string): boolean {
    return (this.sessions.get(sessionCode)?.size ?? 0) > 0;
  }

  /**
   * Records that memberId spawned objectId in sessionCode, keeping the raw
   * message for replay. `category` defaults to "player" (C3): every A1-C2
   * caller predates the category field and means a player-ship spawn.
   */
  recordSpawn(sessionCode: string, memberId: string, objectId: string, raw: string, category: SpawnCategory = "player"): void {
    const bySession = this.spawnsBySession.get(sessionCode) ?? new Map<string, string>();
    bySession.set(objectId, raw);
    this.spawnsBySession.set(sessionCode, bySession);
    const owned = this.spawnsByMember.get(memberId) ?? new Set<string>();
    owned.add(objectId);
    this.spawnsByMember.set(memberId, owned);
    this.ownerByObjectId.set(objectId, memberId);
    this.categoryByObjectId.set(objectId, category);
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
      this.categoryByObjectId.delete(objectId);
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
      this.categoryByObjectId.delete(objectId);
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

  /**
   * Count of memberId's currently active "npc"-category spawns (C3), enforced
   * against MAX_NPC_SPAWNS_PER_CLIENT in server.ts -- a SEPARATE budget from
   * hasOtherActiveSpawn's one-"player"-spawn cap above, not a relaxation of
   * it. A re-spawn of an objectId the member already owns doesn't change this
   * count (spawnsByMember is a Set, adding an existing member is a no-op).
   */
  npcSpawnCount(memberId: string): number {
    const owned = this.spawnsByMember.get(memberId);
    if (!owned) return 0;
    let count = 0;
    for (const objectId of owned) {
      if (this.categoryByObjectId.get(objectId) === "npc") count += 1;
    }
    return count;
  }
}
