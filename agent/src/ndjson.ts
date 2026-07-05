import { MAX_MESSAGE_BYTES } from "@xmultiplayer/protocol";

export interface NdjsonSplitterOptions {
  maxLineBytes?: number;
  /** Called when a line (complete or still-buffering) exceeds maxLineBytes; the offending data is dropped, the connection stays usable. */
  onOversizedLine?: (droppedBytes: number) => void;
}

/**
 * Splits a stream of Buffer/string chunks into newline-delimited JSON lines,
 * buffering any partial line that arrives split across chunk boundaries.
 * Used both when reading from the Named Pipe (game -> agent) and in tests.
 *
 * Caps how large a single buffered line may grow (default MAX_MESSAGE_BYTES,
 * shared with parseMessage's own size check and the relay server's WebSocket
 * maxPayload) so a line that never finds its terminating newline -- or a huge
 * completed line -- can't grow this buffer without bound. Oversized data is
 * dropped and reported via onOversizedLine; the stream keeps working afterwards.
 */
export class NdjsonSplitter {
  private buffer = "";
  private readonly maxLineBytes: number;
  private readonly onOversizedLine?: (droppedBytes: number) => void;

  constructor(options: NdjsonSplitterOptions = {}) {
    this.maxLineBytes = options.maxLineBytes ?? MAX_MESSAGE_BYTES;
    this.onOversizedLine = options.onOversizedLine;
  }

  /** Feeds a chunk and returns the complete, in-bounds lines it produced (possibly zero). */
  push(chunk: Buffer | string): string[] {
    this.buffer += chunk.toString();
    const rawLines = this.buffer.split("\n");
    this.buffer = rawLines.pop() ?? "";

    const lines: string[] = [];
    for (const rawLine of rawLines) {
      const line = rawLine.replace(/\r$/, "");
      if (line.length === 0) continue;
      if (this.isOversized(line)) continue;
      lines.push(line);
    }

    // Guard the still-accumulating partial line too, in case a newline never arrives.
    if (this.buffer.length > 0 && this.isOversized(this.buffer)) {
      this.buffer = "";
    }
    return lines;
  }

  /** Returns any buffered partial line as a final line (e.g. on stream close) and clears the buffer. */
  flush(): string[] {
    const remaining = this.buffer.trim();
    this.buffer = "";
    return remaining.length > 0 && !this.isOversized(remaining) ? [remaining] : [];
  }

  private isOversized(line: string): boolean {
    const size = Buffer.byteLength(line, "utf8");
    if (size <= this.maxLineBytes) return false;
    this.onOversizedLine?.(size);
    return true;
  }
}
