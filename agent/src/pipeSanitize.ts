import { sanitizeChatText, sanitizeForPipeExtraction, sanitizePlayerName, type ProtocolMessage } from "@xmultiplayer/protocol";

/**
 * Applies string-safety sanitization to every free-form, client-supplied text
 * field before a message is written into the pipe (A5 security hardening) --
 * `session.playerName`, `chat.from`, `chat.text`, and, since C1,
 * `sector_object.macroName`/`objectId`. Everything else in the protocol is
 * either server-controlled (e.g. `hp_state`, never client-originated), or a
 * client-supplied id/name that IS still free-form but happens not to be
 * exercised by any attack this project has looked at yet (e.g.
 * `spawn.objectId`, a pre-existing gap of the exact same shape as
 * `sector_object.objectId` below, not introduced or closed by C1 -- see
 * docs/C1-messprotokoll.md).
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
 * `sector_object.macroName`/`objectId` (C1) are a step further out on the
 * trust spectrum than shipType: shipType is checked against
 * SHIP_MACRO_WHITELIST before this function ever runs (decideRelay,
 * relayFilter.ts), but no equivalent whitelist exists yet for station/gate/
 * asteroid-field/region macro names or ids (docs/C1-messprotokoll.md) --
 * parseMessage's MAX_MACRO_NAME_LENGTH cap bounds macroName's size (objectId
 * has no length cap of its own beyond the whole message's MAX_MESSAGE_BYTES),
 * but only sanitizeForPipeExtraction here protects the MD extractor from
 * either field containing '{', '}', or ','.
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
  return msg;
}
