import { WebSocket } from "ws";

export interface WsClientOptions {
  url: string;
  onMessage: (data: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * WebSocket client with exponential backoff reconnect. Used for the agent -> relay
 * server link, which must survive the relay server restarting independently of the
 * game/agent process.
 */
export class ReconnectingWebSocket {
  private ws: WebSocket | null = null;
  private backoff: number;
  private closedByUser = false;

  constructor(private opts: WsClientOptions) {
    this.backoff = opts.minBackoffMs ?? 500;
  }

  connect(): void {
    this.ws = new WebSocket(this.opts.url);
    this.ws.on("open", () => {
      this.backoff = this.opts.minBackoffMs ?? 500;
      this.opts.onOpen?.();
    });
    this.ws.on("message", (data) => this.opts.onMessage(data.toString()));
    this.ws.on("close", () => this.handleClose());
    this.ws.on("error", () => {
      /* 'close' always follows 'error' on ws, where reconnect scheduling happens */
    });
  }

  send(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
  }

  private handleClose(): void {
    this.opts.onClose?.();
    if (this.closedByUser) return;
    const delay = this.backoff;
    this.backoff = Math.min(delay * 2, this.opts.maxBackoffMs ?? 10_000);
    setTimeout(() => this.connect(), delay);
  }
}
