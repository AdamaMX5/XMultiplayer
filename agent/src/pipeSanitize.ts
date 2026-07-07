import { sanitizeChatText, sanitizeForPipeExtraction, sanitizePlayerName, type ProtocolMessage } from "@xmultiplayer/protocol";

/**
 * Applies string-safety sanitization to every free-form, player-supplied text
 * field before a message is written into the pipe (A5 security hardening) --
 * `session.playerName`, `chat.from`, `chat.text`. Nothing else in the protocol
 * carries free-form text (shipType/objectId/etc. are either server-controlled
 * or already whitelisted elsewhere), so this only ever touches these fields.
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
  return msg;
}
