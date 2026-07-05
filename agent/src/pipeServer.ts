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
 *
 * Bidirectional since A2: besides reading the local player's own telemetry (onLine),
 * write() pushes other session members' messages (spawn/despawn/state_update, relayed
 * from the WebSocket) down into the game so the mod can react to them (spawn proxies,
 * teleport them on updates).
 */
export class PipeServer {
  private server: Server;
  private activeSocket: Socket | null = null;

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

  /** Writes a single NDJSON line to the currently connected game client, if any. Returns whether it was actually sent. */
  write(line: string): boolean {
    if (!this.activeSocket || this.activeSocket.destroyed) return false;
    this.activeSocket.write(line + "\n");
    return true;
  }

  private handleConnection(socket: Socket): void {
    this.activeSocket = socket;
    this.callbacks.onClientConnected?.();
    const splitter = new NdjsonSplitter({ onOversizedLine: this.callbacks.onOversizedLine });
    socket.on("data", (chunk) => {
      for (const line of splitter.push(chunk)) {
        this.callbacks.onLine(line);
      }
    });
    socket.on("close", () => {
      if (this.activeSocket === socket) this.activeSocket = null;
      this.callbacks.onClientDisconnected?.();
    });
    socket.on("error", (err) => this.callbacks.onError?.(err));
  }
}
