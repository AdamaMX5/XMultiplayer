import { createServer, type Server, type Socket } from "node:net";
import { NdjsonSplitter } from "./ndjson.js";

export interface PipeServerCallbacks {
  /** Called once per complete NDJSON line received from the connected client (the game). */
  onLine: (line: string) => void;
  onListening?: () => void;
  onClientConnected?: () => void;
  onClientDisconnected?: () => void;
  onError?: (err: Error) => void;
  /** Called when an oversized line/chunk was dropped (see NdjsonSplitter); the connection stays open. */
  onOversizedLine?: (droppedBytes: number) => void;
}

/**
 * Named Pipe server the agent exposes for the game to connect to. The game (via the
 * SirNukes Mod Support APIs) is the pipe *client*; the agent stays listening so that
 * closing/reopening the game (pipe client disconnect/reconnect) does not require
 * restarting the agent -- see docs/A1-messprotokoll.md for the framing assumption.
 */
export class PipeServer {
  private server: Server;

  constructor(private path: string, private callbacks: PipeServerCallbacks) {
    this.server = createServer((socket) => this.handleConnection(socket));
    this.server.on("error", (err) => this.callbacks.onError?.(err));
  }

  start(): void {
    this.server.listen(this.path, () => this.callbacks.onListening?.());
  }

  stop(): void {
    this.server.close();
  }

  private handleConnection(socket: Socket): void {
    this.callbacks.onClientConnected?.();
    const splitter = new NdjsonSplitter({ onOversizedLine: this.callbacks.onOversizedLine });
    socket.on("data", (chunk) => {
      for (const line of splitter.push(chunk)) {
        this.callbacks.onLine(line);
      }
    });
    socket.on("close", () => this.callbacks.onClientDisconnected?.());
    socket.on("error", (err) => this.callbacks.onError?.(err));
  }
}
