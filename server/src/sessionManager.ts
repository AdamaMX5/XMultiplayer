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
  // objectId -> its SpawnMessage.shipType (C4), same parallel-map idiom as
  // categoryByObjectId. Needed so the kill-feed (server.ts's broadcastKillFeed)
  // can name a destroyed NPC by its ship type instead of misattributing it to
  // the exporting player's own name (docs/C3-messprotokoll.md section 5.6's
  // documented "emergent, not intended" flaw, fixed in C4) -- undefined for any
  // spawn recorded before this field existed (no caller currently omits it, but
  // treated as optional the same way category itself is).
  private shipTypeByObjectId = new Map<string, string>();
  // objectId -> the memberId that exported it via `sector_object` (C1), populated
  // here since C6: "Kommando-Relay" needs to route a `dock_request` to the ONE
  // member who actually owns/exported the target station, instead of broadcasting
  // it to the whole session the way every other sector_object-adjacent message is.
  // A parallel map to ownerByObjectId rather than folding sector_object into that
  // same map/lifecycle: ownerByObjectId's cleanup/respawn rules (recordSpawn's
  // respawn-replaces semantics, hasOtherActiveSpawn's one-active-spawn cap,
  // npcSpawnCount's category filter) are all specific to SPAWNED objects
  // (ships/NPCs with HP and a despawn path) -- sector_object has none of that (no
  // despawn message type has ever existed for it, C1's own deliberate choice), so
  // reusing ownerByObjectId's machinery for it would mean bending a lifecycle
  // built for a fundamentally different kind of thing.
  private sectorObjectOwnerByObjectId = new Map<string, string>();
  // memberId -> every objectId that member has ever exported via `sector_object`,
  // so a disconnect can forget all of them (mirrors spawnsByMember/
  // takeSpawnedObjectIds' own disconnect-cleanup shape, C6).
  private sectorObjectIdsByMember = new Map<string, Set<string>>();

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
   * `shipType` (C4) is optional so pre-C4 test callers stay valid; server.ts's
   * one real caller always supplies it (SpawnMessage.shipType is a required
   * field on the wire, protocol/src/parse.ts).
   */
  recordSpawn(sessionCode: string, memberId: string, objectId: string, raw: string, category: SpawnCategory = "player", shipType?: string): void {
    const bySession = this.spawnsBySession.get(sessionCode) ?? new Map<string, string>();
    bySession.set(objectId, raw);
    this.spawnsBySession.set(sessionCode, bySession);
    const owned = this.spawnsByMember.get(memberId) ?? new Set<string>();
    owned.add(objectId);
    this.spawnsByMember.set(memberId, owned);
    this.ownerByObjectId.set(objectId, memberId);
    this.categoryByObjectId.set(objectId, category);
    if (shipType !== undefined) this.shipTypeByObjectId.set(objectId, shipType);
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
      this.shipTypeByObjectId.delete(objectId);
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
      this.shipTypeByObjectId.delete(objectId);
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
   * The SpawnMessage.category recorded for objectId, if any (C4, server.ts's
   * destroyObject/broadcastKillFeed: an NPC's destruction must be named
   * differently from a player ship's). Must be read BEFORE removeSpawn()/
   * takeSpawnedObjectIds() forgets it, same ordering requirement as ownerOf()
   * already has for the kill-feed's attacker/victim lookup.
   */
  categoryOf(objectId: string): SpawnCategory | undefined {
    return this.categoryByObjectId.get(objectId);
  }

  /** The SpawnMessage.shipType recorded for objectId, if any (C4, same read-before-removeSpawn ordering requirement as categoryOf()). */
  shipTypeOf(objectId: string): string | undefined {
    return this.shipTypeByObjectId.get(objectId);
  }

  /**
   * Records that memberId exported objectId via `sector_object` (C1). Unlike
   * recordSpawn, there is no "respawn"/replace concept here -- re-exporting the
   * same objectId (e.g. C5's sector_change re-export) just re-affirms the same
   * ownership entry, a harmless overwrite with the same value in the common
   * case. Called unconditionally for every inbound `sector_object`, same trust
   * posture C1 already established for that message type (no per-sender cap,
   * see MAX_SECTOR_OBJECTS_PER_MIRROR's own enforcement in server.ts instead).
   */
  recordSectorObject(memberId: string, objectId: string): void {
    this.sectorObjectOwnerByObjectId.set(objectId, memberId);
    const owned = this.sectorObjectIdsByMember.get(memberId) ?? new Set<string>();
    owned.add(objectId);
    this.sectorObjectIdsByMember.set(memberId, owned);
  }

  /**
   * The memberId that exported objectId via `sector_object`, if any (C6
   * "Kommando-Relay"). server.ts's `dock_request` handling routes to this
   * member instead of broadcasting; `dock_response` handling rejects a sender
   * who is not this member. Undefined means "nobody has exported this
   * objectId" -- callers must treat that as "unroutable", not "anyone may
   * claim it", same posture ownerOf() already has for spawned objects.
   */
  sectorObjectOwnerOf(objectId: string): string | undefined {
    return this.sectorObjectOwnerByObjectId.get(objectId);
  }

  /**
   * Forgets every sector_object memberId has ever exported (disconnect
   * cleanup, C6) -- mirrors takeSpawnedObjectIds' shape for spawned objects,
   * though sector_object has no per-session replay list to also clean up (C1
   * never added one, "no re-export throttling", see docs/C1-messprotokoll.md).
   */
  forgetSectorObjectsOf(memberId: string): void {
    const owned = this.sectorObjectIdsByMember.get(memberId);
    this.sectorObjectIdsByMember.delete(memberId);
    if (!owned) return;
    for (const objectId of owned) {
      this.sectorObjectOwnerByObjectId.delete(objectId);
    }
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
