/**
 * Shared string-safety helpers for free-form, player-supplied text
 * (SessionMessage.playerName, ChatMessage.from/text) -- A5 security hardening
 * for internet exposure. Kept in protocol/ (not server/ or agent/) since both
 * sides need the exact same rules: the server sanitizes before logging/
 * broadcasting, the agent sanitizes (more aggressively) again before writing
 * into the pipe, and both must agree on what "sanitized" means.
 */

/** Display name length cap. Generous for any real player name, small enough to bound log/broadcast size. */
export const MAX_PLAYER_NAME_LENGTH = 32;

/** Chat message length cap. */
export const MAX_CHAT_TEXT_LENGTH = 256;

/**
 * Strips C0 control characters (0x00-0x1F) and DEL (0x7F) -- newlines, carriage
 * returns, escape sequences, etc. A player name or chat message containing a
 * raw newline could otherwise inject fake-looking log lines into the server's
 * console output (log injection), and terminal escape sequences could do worse
 * to whatever terminal is tailing that log.
 */
export function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: this IS the control-char filter.
  return value.replace(/[\x00-\x1F\x7F]/g, "");
}

export function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

/** Control-char strip + length cap for a display name. */
export function sanitizePlayerName(value: string): string {
  return truncate(stripControlChars(value), MAX_PLAYER_NAME_LENGTH);
}

/** Control-char strip + length cap for chat text. */
export function sanitizeChatText(value: string): string {
  return truncate(stripControlChars(value), MAX_CHAT_TEXT_LENGTH);
}

/**
 * Additionally strips '{', '}', ',' -- the exact characters that break
 * mod/md/XMP_Arena.xml's XMP_Arena_ExtractField, the MD-side naive
 * string-search field extractor (documented, pre-existing gap: a string value
 * containing a literal '}' or ',' truncates extraction early, since the
 * end-boundary search has no concept of quoted-string content -- see
 * docs/A2-messprotokoll.md/A3-messprotokoll.md). A player name like
 * "{CoolClan} Alice" would otherwise silently corrupt whatever MD field comes
 * after it in the JSON line. Only the agent needs this (right before writing
 * into the pipe) -- the server's own log/broadcast sanitization doesn't need
 * to protect MD's parser, only the pipe does. Aggressive removal, not
 * escaping: losing a character from a display name is a cosmetic problem, a
 * broken MD field extraction is a correctness one, and cosmetics lose.
 */
export function sanitizeForPipeExtraction(value: string): string {
  return value.replace(/[{},]/g, "");
}
