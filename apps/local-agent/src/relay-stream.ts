import type { Duplex } from "node:stream";

/**
 * One end of a reliable byte stream that crosses the panel between two hosts.
 *
 * The panel only forwards frames, so everything that makes the stream survive a dropped WebSocket lives here:
 * sequence numbers, cumulative acknowledgements, a bounded retransmission window, and a resume handshake.
 * Data that was in flight when a transport died is kept in `unacked` and resent after `relay.resume`, so the
 * SSH session on top of it never notices a short reconnect.
 */
export type RelayFrame = Record<string, unknown>;

export const RELAY_CHUNK_BYTES = 16 * 1024;
export const RELAY_WINDOW_BYTES = 256 * 1024;
/** A peer is never trusted with bigger frames than this, whatever chunk size it uses itself. */
const MAX_INBOUND_CHUNK = 64 * 1024;
const ACK_DELAY_MS = 20;

export interface RelayStreamOptions {
  id: string;
  local: Duplex;
  /** Returns false when the transport is not available; the frame then stays queued for the resume. */
  send: (frame: RelayFrame) => boolean;
  onClosed: (reason: string) => void;
  chunkBytes?: number;
  windowBytes?: number;
}

interface Pending { seq: number; data: Buffer; fin: boolean }

const isSeq = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export class RelayStream {
  readonly id: string;
  private readonly local: Duplex;
  private readonly send: RelayStreamOptions["send"];
  private readonly onClosed: RelayStreamOptions["onClosed"];
  private readonly chunkBytes: number;
  private readonly windowBytes: number;

  private nextSeq = 1;
  private unacked: Pending[] = [];
  private unackedBytes = 0;
  private peerAck = 0;
  private recvSeq = 0;
  private deliveredSeq = 0;
  private ackSent = 0;
  private connected = true;
  private finSeq = 0;
  private finReceived = false;
  private finDelivered = false;
  private closed = false;
  private paused = false;
  private ackTimer: NodeJS.Timeout | undefined;
  bytesOut = 0;
  bytesIn = 0;

  constructor(options: RelayStreamOptions) {
    this.id = options.id;
    this.local = options.local;
    this.send = options.send;
    this.onClosed = options.onClosed;
    this.chunkBytes = options.chunkBytes ?? RELAY_CHUNK_BYTES;
    this.windowBytes = options.windowBytes ?? RELAY_WINDOW_BYTES;
    this.local.on("data", (chunk: Buffer) => this.fromLocal(chunk));
    this.local.on("end", () => this.localEnded());
    this.local.on("error", () => this.abort("local_error"));
    // A local socket that vanishes without ever signalling its end is an abort. One that ended cleanly may close before the
    // peer has acknowledged our final frame; the retransmission must keep working until it does, so that is not an abort.
    this.local.on("close", () => { if (!this.closed && this.finSeq === 0) this.abort("local_closed"); });
  }

  get isClosed() { return this.closed; }
  get pendingBytes() { return this.unackedBytes; }

  // ---- local -> peer ----

  private fromLocal(chunk: Buffer) {
    if (this.closed || this.finSeq) return;
    for (let offset = 0; offset < chunk.length; offset += this.chunkBytes) {
      const data = chunk.subarray(offset, offset + this.chunkBytes);
      this.queue({ seq: this.nextSeq++, data: Buffer.from(data), fin: false });
      this.bytesOut += data.length;
    }
    // Stop reading from the local socket until the peer has confirmed enough, so memory stays bounded.
    if (this.unackedBytes >= this.windowBytes && !this.paused) { this.paused = true; this.local.pause(); }
  }

  private localEnded() {
    if (this.closed || this.finSeq) return;
    this.finSeq = this.nextSeq;
    this.queue({ seq: this.nextSeq++, data: Buffer.alloc(0), fin: true });
  }

  private queue(frame: Pending) {
    this.unacked.push(frame);
    this.unackedBytes += frame.data.length;
    if (this.connected) this.transmit(frame);
  }

  private transmit(frame: Pending) {
    this.send({
      type: "relay.data", streamId: this.id, seq: frame.seq, ack: this.deliveredSeq,
      ...(frame.data.length ? { data: frame.data.toString("base64") } : {}), ...(frame.fin ? { fin: true } : {}),
    });
    this.ackSent = Math.max(this.ackSent, this.deliveredSeq);
  }

  // ---- transport lifecycle (driven by the manager) ----

  transportLost() { this.connected = false; }

  /** The WebSocket is back and the host is reconciled: tell the peer where we are so it can resend what we missed. */
  transportReady() {
    if (this.closed) return;
    this.connected = true;
    this.send({ type: "relay.resume", streamId: this.id, recvSeq: this.recvSeq });
  }

  // ---- peer -> local ----

  handleFrame(frame: RelayFrame) {
    if (this.closed) return;
    switch (frame.type) {
      case "relay.data": return this.onData(frame);
      case "relay.ack": return isSeq(frame.ack) ? this.applyAck(frame.ack) : this.abort("protocol");
      case "relay.resume": return this.onResume(frame);
      case "relay.close": {
        const reason = typeof frame.reason === "string" && /^[a-z_]{1,48}$/.test(frame.reason) ? frame.reason : "closed";
        // The peer finished cleanly, which it only does once everything crossing both ways has been delivered and acknowledged.
        return reason === "complete" ? this.finish("complete") : this.abort(`peer_${reason}`);
      }
      default: return this.abort("protocol");
    }
  }

  private onData(frame: RelayFrame) {
    const { seq, ack } = frame;
    if (!isSeq(seq) || seq < 1 || !isSeq(ack) || (frame.data !== undefined && typeof frame.data !== "string") || (frame.fin !== undefined && typeof frame.fin !== "boolean")) return this.abort("protocol");
    this.applyAck(ack);
    if (this.closed) return;
    if (seq <= this.recvSeq) { this.scheduleAck(); return; } // a retransmission of something already accepted
    if (seq !== this.recvSeq + 1) return; // a gap can only be repaired by the resume handshake
    const data = typeof frame.data === "string" ? Buffer.from(frame.data, "base64") : Buffer.alloc(0);
    if (data.length > MAX_INBOUND_CHUNK) return this.abort("protocol");
    this.recvSeq = seq;
    if (frame.fin === true) {
      this.finReceived = true;
      this.local.end(() => { this.deliveredSeq = Math.max(this.deliveredSeq, seq); this.finDelivered = true; this.scheduleAck(); this.maybeComplete(); });
      return;
    }
    this.bytesIn += data.length;
    this.local.write(data, error => {
      if (error) return this.abort("local_error");
      this.deliveredSeq = Math.max(this.deliveredSeq, seq);
      this.scheduleAck();
    });
  }

  private onResume(frame: RelayFrame) {
    if (!isSeq(frame.recvSeq)) return this.abort("protocol");
    this.applyAck(frame.recvSeq);
    if (this.closed) return;
    for (const pending of this.unacked) this.transmit(pending);
    // Both sides need to learn the other's position; the reply flag stops the exchange from echoing forever.
    if (frame.reply !== true) this.send({ type: "relay.resume", streamId: this.id, recvSeq: this.recvSeq, reply: true });
    this.maybeComplete();
  }

  private applyAck(ack: number) {
    if (ack >= this.nextSeq) return this.abort("protocol"); // the peer cannot have received what was never sent
    if (ack <= this.peerAck) return;
    this.peerAck = ack;
    while (this.unacked.length && this.unacked[0]!.seq <= ack) this.unackedBytes -= this.unacked.shift()!.data.length;
    if (this.paused && this.unackedBytes <= this.windowBytes / 2) { this.paused = false; this.local.resume(); }
    this.maybeComplete();
  }

  private scheduleAck() {
    if (this.closed || this.ackTimer) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = undefined;
      if (this.closed || this.deliveredSeq <= this.ackSent || !this.connected) return;
      this.ackSent = this.deliveredSeq;
      this.send({ type: "relay.ack", streamId: this.id, ack: this.deliveredSeq });
    }, ACK_DELAY_MS);
    this.ackTimer.unref();
  }

  // ---- completion ----

  private isComplete() { return this.finSeq > 0 && this.peerAck >= this.finSeq && this.finReceived && this.finDelivered; }

  private maybeComplete() {
    if (this.closed || !this.isComplete()) return;
    // Make sure the peer learns that its final frame was delivered before this side lets go.
    if (this.deliveredSeq > this.ackSent && this.connected) { this.ackSent = this.deliveredSeq; this.send({ type: "relay.ack", streamId: this.id, ack: this.deliveredSeq }); }
    this.finish("complete");
  }

  private finish(reason: string) {
    if (this.closed) return;
    this.closed = true;
    if (this.ackTimer) clearTimeout(this.ackTimer);
    // The panel only forwards frames, so it learns that a stream is over from this; otherwise it would keep it until it idled out.
    if (reason === "complete") this.send({ type: "relay.close", streamId: this.id, reason });
    this.local.destroy();
    this.onClosed(reason);
  }

  /** Tear the stream down. A reason that starts with `peer_` came from the other end, which already knows. */
  abort(reason: string) {
    if (this.closed) return;
    if (!reason.startsWith("peer_")) this.send({ type: "relay.close", streamId: this.id, reason });
    this.finish(reason);
  }
}
