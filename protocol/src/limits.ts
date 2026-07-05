/**
 * Shared size cap for a single wire message (one NDJSON line on the pipe, one
 * WebSocket text frame). Without a cap, a line that never finds its terminating
 * newline (or an oversized WebSocket frame) grows a receive buffer without bound --
 * a resource-exhaustion vector. Enforced in three places using this same constant:
 *   - parseMessage() in parse.ts (rejects an oversized payload outright)
 *   - NdjsonSplitter in agent/src/ndjson.ts (drops an oversized buffered line/chunk)
 *   - the relay server's WebSocketServer `maxPayload` option (server/src/server.ts)
 */
export const MAX_MESSAGE_BYTES = 64 * 1024;
