import test from "node:test";
import assert from "node:assert/strict";
import { encode, decode, gainFor } from "../src/protocol.mjs";
import { World, parseEnvironment, resolveWorld } from "../src/world.mjs";
import { mix, pcmBytes, outputSamples } from "../src/audio.mjs";
import { Codex } from "../src/codex.mjs";
import { parseArgs } from "../src/cli.mjs";

function world() {
  const w = new World();
  w.receive("snapshot", {
    id: "self",
    entities: [
      { type: "player", id: "self", position: [0, 0, 0] },
      { type: "player", id: "near", position: [1, 0, 0] },
      { type: "player", id: "far", position: [100, 0, 0] },
    ],
    settings: { voice: "spatial" },
    livekit: { levels: {}, muted: new Set() },
  });
  return w;
}
test("engine packets preserve Sets and coordinate updates", () => {
  assert.deepEqual(decode(encode("mute", { muted: new Set(["p"]) })), [
    "mute",
    { muted: new Set(["p"]) },
  ]);
  const w = world();
  w.receive("entityModified", { id: "near", p: [30, 0, 0] });
  assert.equal(gainFor(w, "near"), 0);
  w.receive("entityRemoved", "far");
  assert.equal(w.players.has("far"), false);
});
test("proximity gates self, missing positions, distant, muted, and disabled players", () => {
  const w = world();
  assert.equal(gainFor(w, "near"), 1);
  assert.equal(gainFor(w, "far"), 0);
  assert.equal(gainFor(w, "self"), 0);
  assert.equal(gainFor(w, "unknown"), 0);
  w.receive("mute", { playerId: "near", muted: true });
  assert.equal(gainFor(w, "near"), 0);
  w.receive("mute", { playerId: "near", muted: false });
  w.receive("liveKitLevel", { playerId: "near", level: "disabled" });
  assert.equal(gainFor(w, "near"), 0);
  w.receive("liveKitLevel", { playerId: "far", level: "global" });
  assert.equal(gainFor(w, "far"), 1);
  w.players.get("near").position = [NaN, 0, 0];
  assert.equal(gainFor(w, "near"), 0);
});
test("engine attenuation is applied before mixing and clips safely", () => {
  const w = world();
  w.players.get("near").position = [2, 0, 0];
  assert.equal(gainFor(w, "near"), 0.25);
  const data = new Int16Array(480).fill(30000);
  assert.equal(mix([{ data, gain: 0.25 }])[0], 7500);
  assert.equal(
    mix([
      { data, gain: 1 },
      { data, gain: 1 },
    ])[0],
    32767,
  );
  assert.equal(mix([])[0], 0);
});
test("PCM decoding honors offsets, channels, and rate", () => {
  const values = new Int16Array([1000, 3000, -1000, -3000]);
  const result = outputSamples({
    data: pcmBytes(values).toString("base64"),
    numChannels: 2,
    sampleRate: 24000,
  });
  assert.deepEqual([...result], [2000, -2000]);
  assert.throws(() =>
    outputSamples({ data: "AAA=", numChannels: 3, sampleRate: 24000 }),
  );
});
test("parse env.js as data and honor appended pool join setting", () => {
  assert.deepEqual(
    parseEnvironment(
      'globalThis.env = {"PUBLIC_WS_URL":"wss://example/ws"}\nglobalThis.env.PUBLIC_JOIN_URL="https://example/join";',
    ),
    {
      PUBLIC_WS_URL: "wss://example/ws",
      PUBLIC_JOIN_URL: "https://example/join",
    },
  );
  assert.deepEqual(parseEnvironment("process.exit(1)"), {});
});
test("pool admission appends fresh ticket and reports city", async () => {
  const calls = [];
  const target = await resolveWorld("https://example/", async (url, opts) => {
    calls.push([String(url), opts]);
    if (calls.length === 1)
      return new Response('globalThis.env = {"PUBLIC_JOIN_URL":"/join"}');
    return Response.json({
      wsUrl: "wss://example/instances/city/ws?x=1",
      ticket: "secret",
      instanceId: "city",
    });
  });
  assert.equal(target.instanceId, "city");
  assert.equal(
    new URL(target.wsUrl).searchParams.get("admissionTicket"),
    "secret",
  );
  assert.equal(calls[1][1].method, "POST");
  assert.ok(calls[1][1].headers["x-lobby-tab"]);
  await assert.rejects(
    resolveWorld(
      "https://example/",
      async () => new Response("", { status: 503 }),
    ),
    /503/,
  );
});
test("direct WebSocket URL remains intact", async () => {
  const target = await resolveWorld(
    "wss://example/instances/city/ws?admissionTicket=x",
    () => {
      throw Error("unexpected fetch");
    },
  );
  assert.equal(
    target.wsUrl,
    "wss://example/instances/city/ws?admissionTicket=x",
  );
});
test("movement can only change this player and rejects invalid data", () => {
  const w = world(),
    sent = [];
  w.send = (...args) => sent.push(args);
  w.setPosition([3, 4, 5]);
  assert.deepEqual(sent[0], [
    "entityModified",
    { id: "self", p: [3, 4, 5], t: true },
  ]);
  assert.throws(() => w.setPosition([NaN, 0, 0]));
  assert.throws(() => w.say(""));
});
test("tool dispatcher refuses ambient tools and errors stay tool results", async () => {
  const c = new Codex({ world: world(), cwd: "." });
  c.threadId = "t";
  const results = [];
  c.write = (m) => results.push(m);
  await c.handleTool({
    id: 1,
    method: "item/commandExecution/requestApproval",
    params: {},
  });
  assert.equal(results[0].error.code, -32601);
  await c.handleTool({
    id: 2,
    method: "item/tool/call",
    params: {
      threadId: "t",
      tool: "world_move",
      arguments: { position: [Infinity, 0, 0] },
    },
  });
  assert.equal(results[1].result.success, false);
  await c.handleTool({
    id: 3,
    method: "item/tool/call",
    params: { threadId: "t", tool: "world_status", arguments: {} },
  });
  assert.equal(results[2].result.success, true);
});
test("Codex request timeouts release pending state and exit rejects requests", async () => {
  const c = new Codex({ cwd: ".", timeout: 5 });
  c.write = () => {};
  await assert.rejects(c.request("never"), /timed out/);
  assert.equal(c.pending.size, 0);
  const pending = c.request("exit");
  c.failed(new Error("gone"));
  await assert.rejects(pending, /gone/);
});
test("CLI defaults to devnet and validates options", () => {
  assert.equal(parseArgs([]).options.url, "https://devnet.load.game/");
  assert.equal(parseArgs(["--name", "Friend"]).options.name, "Friend");
  assert.throws(() => parseArgs(["--radius", "NaN"]));
  assert.throws(() => parseArgs(["--token", "x"]));
});

test("typed requests use Codex turns, preserving the user role during voice", async () => {
  const c = new Codex({ cwd: "." });
  c.ready = true;
  c.threadId = "t";
  const calls = [];
  c.request = async (method, params) => {
    calls.push({ method, params });
    queueMicrotask(() =>
      c.emit("turn/completed", {
        threadId: "t",
        turn: { status: "completed" },
      }),
    );
  };
  await c.text("Who is nearby?");
  assert.equal(calls[0].method, "turn/start");
  assert.equal(calls[0].params.input[0].text, "Who is nearby?");
});

test("buffered input is discarded when a player moves out of range", async () => {
  const { Voice } = await import("../src/audio.mjs");
  const { EventEmitter } = await import("node:events");
  const w = world(),
    c = new EventEmitter(),
    sent = [];
  c.ready = true;
  c.appendAudio = async (data) => sent.push(data);
  const voice = new Voice(w, c);
  voice.source = { queuedDuration: 0 };
  const input = {
    identity: "near",
    frames: [new Int16Array(480).fill(1000)],
    track: {},
  };
  voice.inputs.set("track", input);
  w.players.get("near").position = [100, 0, 0];
  voice.tick();
  assert.equal(input.frames.length, 0);
  assert.ok(sent[0].every((n) => n === 0));
  assert.equal(voice.stats.inputSamples, 0);
});

test("moderator mute clears pending output and blocks new speech", async () => {
  const { Voice } = await import("../src/audio.mjs");
  const { EventEmitter } = await import("node:events");
  const w = world(),
    voice = new Voice(w, new EventEmitter());
  let cleared = 0;
  voice.source = {
    clearQueue() {
      cleared++;
    },
  };
  voice.output = [new Int16Array(480)];
  voice.outputSize = 480;
  w.muted.add(w.id);
  voice.onWorld();
  assert.equal(voice.outputSize, 0);
  assert.equal(cleared, 1);
  voice.enqueue({
    data: pcmBytes(new Int16Array(480)).toString("base64"),
    sampleRate: 24000,
    numChannels: 1,
  });
  assert.equal(voice.outputSize, 0);
});
