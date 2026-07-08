import { sanitizeChatText, sanitizeForPipeExtraction, sanitizePlayerName, type ProtocolMessage } from "@xmultiplayer/protocol";

/**
 * Applies string-safety sanitization to every free-form, client-supplied text
 * field before a message is written into the pipe (A5 security hardening) --
 * `session.playerName`, `chat.from`, `chat.text`, `sector_object.macroName`/
 * `objectId` (C1), and, since C3, `spawn.shipType`/`objectId` but ONLY for
 * `category: "npc"` spawns (see below for why player spawns are different).
 * Everything else in the protocol is either server-controlled (e.g.
 * `hp_state`, never client-originated), or a client-supplied id/name that IS
 * still free-form but happens not to be exercised by any attack this project
 * has looked at yet (a PLAYER spawn's `shipType`/`objectId`: `shipType` is
 * whitelist-checked before this ever runs, never free text to begin with, and
 * `objectId` is a pre-existing, deliberately deferred gap, unchanged since C1
 * -- see docs/C1-messprotokoll.md's "Nächste Schritte").
 *
 * Two layers, in order: the general control-char-strip + length-cap rules
 * (`sanitizePlayerName`/`sanitizeChatText`, shared with the server's own
 * logging/broadcast sanitization) PLUS, agent-only, `sanitizeForPipeExtraction`
 * -- MD's `XMP_Arena_ExtractField` naive string-search extractor breaks on a
 * literal '{', '}', or ',' inside a string value (documented, pre-existing gap,
 * docs/A2-messprotokoll.md/A3-messprotokoll.md), so a name like
 * "{CoolClan} Alice" would otherwise corrupt whatever JSON field comes after it
 * on the MD side. The server doesn't need this second layer since it never
 * feeds MD's parser directly.
 *
 * `sector_object.macroName`/`objectId` (C1) and, since C3, an "npc" spawn's
 * `shipType`/`objectId` are a step further out on the trust spectrum than a
 * PLAYER spawn's `shipType`: that one is checked against
 * SHIP_MACRO_WHITELIST before this function ever runs (decideRelay,
 * relayFilter.ts), but no equivalent whitelist exists for "npc" shipType
 * (protocol/src/messages.ts's SpawnMessage.category doc comment) or for
 * station/gate/asteroid-field/region macro names (docs/C1-messprotokoll.md)
 * -- parseMessage's MAX_MACRO_NAME_LENGTH cap bounds shipType/macroName's
 * size either way, but only sanitizeForPipeExtraction here protects the MD
 * extractor from any of these fields containing '{', '}', or ','.
 */
export function sanitizeForPipe(msg: ProtocolMessage): ProtocolMessage {
  if (msg.type === "session" && msg.playerName !== undefined) {
    return { ...msg, playerName: sanitizeForPipeExtraction(sanitizePlayerName(msg.playerName)) };
  }
  if (msg.type === "chat") {
    return {
      ...msg,
      from: sanitizeForPipeExtraction(sanitizePlayerName(msg.from)),
      text: sanitizeForPipeExtraction(sanitizeChatText(msg.text)),
    };
  }
  if (msg.type === "sector_object") {
    return { ...msg, objectId: sanitizeForPipeExtraction(msg.objectId), macroName: sanitizeForPipeExtraction(msg.macroName) };
  }
  if (msg.type === "spawn" && msg.category === "npc") {
    return { ...msg, objectId: sanitizeForPipeExtraction(msg.objectId), shipType: sanitizeForPipeExtraction(msg.shipType) };
  }
  return msg;
}
