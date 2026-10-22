import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import { RelayStream, type RelayFrame } from "../src/relay-stream.js";

/**
 * A real loopback socket pair: `local` is what the stream owns, `app` is the SSH side talking to it.
 * Half-open must be allowed: one side ending its input must not close the direction still carrying data back.
 */
async function socketPair(): Promise<{ local: net.Socket; app: net.Socket }> {
  const server = net.createServer({ allowHalfOpen: true });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const accepted = new Promise<net.Socket>(resolve => server.once("connection", resolve));
  const app = net.connect({ port, host: "127.0.0.1", allowHalfOpen: true });
  await new Promise<void>(resolve => app.once("connect", resolve));
  const local = await accepted;
  server.close();
  return { local, app };
}

/** A link between two stream ends that can go down (losing what is in flight), duplicate frames, or delay delivery. */
class Wire {
  up = true;
  duplicate = false;
  /** Every frame either end handed to the link, in order, for tests that care what was said. */
  readonly frames: Array<{ side: "a" | "b"; frame: RelayFrame }> = [];
  private generation = 0;
  sent = 0;
  a!: RelayStream; b!: RelayStream;
  sendFrom(side: "a" | "b") {
    return (frame: RelayFrame) => {
      if (!this.up) return false;
      this.sent++;
      this.frames.push({ side, frame: JSON.parse(JSON.stringify(frame)) as RelayFrame });
      const copy = JSON.parse(JSON.stringify(frame)) as RelayFrame;
      const generation = this.generation;
      const deliver = () => { if (generation === this.generation && this.up) (side === "a" ? this.b : this.a).handleFrame(JSON.parse(JSON.stringify(copy))); };
      setImmediate(deliver);
      if (this.duplicate) setImmediate(deliver);
      return true;
    };
  }
  down() { this.up = false; this.generation++; this.a.transportLost(); this.b.transportLost(); }
  recover() { this.up = true; this.a.transportReady(); this.b.transportReady(); }
}

async function pairOfStreams(options: { windowBytes?: number; chunkBytes?: number } = {}) {
  const left = await socketPair(); const right = await socketPair();
  const wire = new Wire();
  const closed: { a?: string; b?: string } = {};
  wire.a = new RelayStream({ id: "s1", local: left.local, send: wire.sendFrom("a"), onClosed: reason => { closed.a = reason; }, ...options });
  wire.b = new RelayStream({ id: "s1", local: right.local, send: wire.sendFrom("b"), onClosed: reason => { closed.b = reason; }, ...options });
  return { wire, closed, appA: left.app, appB: right.app };
}

const collect = (socket: net.Socket) => {
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>(resolve => { socket.on("data", chunk => chunks.push(chunk)); socket.on("end", () => resolve(Buffer.concat(chunks))); socket.on("close", () => resolve(Buffer.concat(chunks))); });
  return { chunks, done };
};
const sha = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
const until = async (check: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise(resolve => setTimeout(resolve, 5)); } };

test("bytes flow both ways in order and the stream completes when both sides end", async () => {
  const { closed, appA, appB } = await pairOfStreams();
  const atA = collect(appA), atB = collect(appB);
  const toB = randomBytes(300_000), toA = randomBytes(120_000);
  appA.write(toB); appB.write(toA);
  appA.end(); appB.end();
  const [gotAtB, gotAtA] = await Promise.all([atB.done, atA.done]);
  assert.equal(sha(gotAtB), sha(toB));
  assert.equal(sha(gotAtA), sha(toA));
  await until(() => closed.a === "complete" && closed.b === "complete");
});

test("a slow reader makes the sender stop reading instead of buffering without bound", async () => {
  const { wire, appA, appB } = await pairOfStreams({ windowBytes: 64 * 1024 });
  appB.pause(); // the SSH side on B is not consuming
  // Far more than the kernel buffers on loopback, otherwise the paused reader would simply absorb it.
  const payload = randomBytes(24 * 1024 * 1024);
  let written = 0;
  const writer = (async () => { for (let offset = 0; offset < payload.length; offset += 32_768) { if (!appA.write(payload.subarray(offset, offset + 32_768))) await new Promise(resolve => appA.once("drain", resolve)); written = offset + 32_768; } appA.end(); })();
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.ok(wire.a.pendingBytes <= 64 * 1024 + 16 * 1024, `unacknowledged data stays near the window (was ${wire.a.pendingBytes})`);
  assert.ok(written < payload.length, "the writer was held back by flow control");
  const atB = collect(appB);
  appB.resume(); appB.end();
  const got = await atB.done;
  await writer;
  assert.equal(sha(got), sha(payload));
});

test("a dropped transport loses nothing: in-flight data is resent after the resume handshake", async () => {
  const { wire, closed, appA, appB } = await pairOfStreams({ chunkBytes: 4096 });
  const atB = collect(appB), atA = collect(appA);
  const toB = randomBytes(2_000_000), toA = randomBytes(900_000);
  const feed = async (socket: net.Socket, data: Buffer) => { for (let offset = 0; offset < data.length; offset += 20_000) { if (!socket.write(data.subarray(offset, offset + 20_000))) await new Promise(resolve => socket.once("drain", resolve)); await new Promise(resolve => setImmediate(resolve)); } socket.end(); };
  const sending = Promise.all([feed(appA, toB), feed(appB, toA)]);
  // Cut the link repeatedly while data is moving, each time losing whatever was in flight.
  for (let round = 0; round < 6; round++) {
    await new Promise(resolve => setTimeout(resolve, 15));
    wire.down();
    await new Promise(resolve => setTimeout(resolve, 20));
    wire.recover();
  }
  await sending;
  const [gotB, gotA] = await Promise.all([atB.done, atA.done]);
  assert.equal(gotB.length, toB.length);
  assert.equal(sha(gotB), sha(toB), "A->B arrived intact, in order, exactly once");
  assert.equal(sha(gotA), sha(toA), "B->A arrived intact, in order, exactly once");
  await until(() => closed.a === "complete" && closed.b === "complete");
});

test("duplicated frames are accepted once", async () => {
  const { wire, closed, appA, appB } = await pairOfStreams({ chunkBytes: 2048 });
  wire.duplicate = true;
  const atB = collect(appB);
  const data = randomBytes(200_000);
  appA.write(data); appA.end(); appB.end();
  const got = await atB.done;
  assert.equal(sha(got), sha(data));
  await until(() => closed.a === "complete" && closed.b === "complete");
});

test("closing both ends cleanly while the final acknowledgement is lost still completes after a resume", async () => {
  const { wire, closed, appA, appB } = await pairOfStreams();
  const atA = collect(appA), atB = collect(appB);
  appA.write(Buffer.from("ping")); appB.write(Buffer.from("pong"));
  await new Promise(resolve => setTimeout(resolve, 30));
  appA.end(); appB.end();
  wire.down(); // the closing frames and their acknowledgements are in flight
  await new Promise(resolve => setTimeout(resolve, 20));
  wire.recover();
  await Promise.all([atA.done, atB.done]);
  await until(() => closed.a === "complete" && closed.b === "complete");
});

test("a reset local connection aborts both ends; an orderly close is just the end of the stream", async () => {
  const reset = await pairOfStreams();
  const atB = collect(reset.appB);
  reset.appA.write(Buffer.from("hello"));
  await new Promise(resolve => setTimeout(resolve, 30));
  reset.appA.resetAndDestroy();
  await until(() => reset.closed.a !== undefined && reset.closed.b !== undefined);
  assert.equal(reset.closed.a, "local_error");
  assert.equal(reset.closed.b, "peer_local_error");
  await atB.done;

  const orderly = await pairOfStreams();
  const atOther = collect(orderly.appB);
  orderly.appA.end(Buffer.from("bye"));
  assert.equal((await atOther.done).toString(), "bye");
  assert.equal(orderly.closed.a, undefined, "one direction ending does not close the stream");
  orderly.appB.end();
  await until(() => orderly.closed.a === "complete" && orderly.closed.b === "complete");
});

test("protocol violations abort: acknowledging bytes never sent, malformed frames, oversized chunks", async () => {
  for (const bad of [
    { type: "relay.ack", streamId: "s1", ack: 5 },
    { type: "relay.data", streamId: "s1", seq: "1", ack: 0 },
    { type: "relay.data", streamId: "s1", seq: 1, ack: 99 },
    { type: "relay.data", streamId: "s1", seq: 1, ack: 0, data: randomBytes(70_000).toString("base64") },
    { type: "relay.resume", streamId: "s1", recvSeq: -1 },
    { type: "relay.unknown", streamId: "s1" },
  ] as RelayFrame[]) {
    const { wire, closed } = await pairOfStreams();
    wire.b.handleFrame(bad);
    assert.equal(closed.b, "protocol", JSON.stringify(bad).slice(0, 60));
  }
});

test("frames after a gap are ignored until the peer repairs it", async () => {
  const { wire, appB } = await pairOfStreams();
  const atB = collect(appB);
  wire.b.handleFrame({ type: "relay.data", streamId: "s1", seq: 3, ack: 0, data: Buffer.from("late").toString("base64") });
  wire.b.handleFrame({ type: "relay.data", streamId: "s1", seq: 1, ack: 0, data: Buffer.from("one-").toString("base64") });
  wire.b.handleFrame({ type: "relay.data", streamId: "s1", seq: 2, ack: 0, data: Buffer.from("two-").toString("base64") });
  wire.b.handleFrame({ type: "relay.data", streamId: "s1", seq: 3, ack: 0, data: Buffer.from("three").toString("base64") });
  wire.b.handleFrame({ type: "relay.data", streamId: "s1", seq: 4, ack: 0, fin: true });
  assert.equal((await atB.done).toString(), "one-two-three");
});

test("finishing cleanly tells the panel, and a peer that finished first ends this side cleanly too", async () => {
  const { wire, closed, appA, appB } = await pairOfStreams();
  const atA = collect(appA), atB = collect(appB);
  appA.end(Buffer.from("one")); appB.end(Buffer.from("two"));
  await Promise.all([atA.done, atB.done]);
  await until(() => closed.a === "complete" && closed.b === "complete");
  for (const side of ["a", "b"] as const) assert.equal(wire.frames.filter(item => item.side === side && item.frame.type === "relay.close" && item.frame.reason === "complete").length, 1, `end ${side} tells the panel once that it finished`);

  // If the peer's completion arrives first, this side finishes cleanly instead of treating it as an abort.
  const late = await pairOfStreams();
  const lateB = collect(late.appB);
  late.appA.end(Buffer.from("x")); late.appB.end();
  await lateB.done;
  late.wire.a.handleFrame({ type: "relay.close", streamId: "s1", reason: "complete" });
  await until(() => late.closed.a !== undefined);
  assert.equal(late.closed.a, "complete");
});
