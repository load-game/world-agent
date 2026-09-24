import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Codex } from "../src/codex.mjs";
import { Voice } from "../src/audio.mjs";
import { audioClass, canAct } from "../src/authority.mjs";
const binding = { ownerPlayerId: "owner", generation: 3 };

test("authority comes from a verified session and generation, never a name or address claim", () => {
  assert.equal(canAct({ type: "guest", playerId: "owner" }, binding), false);
  assert.equal(
    canAct({ type: "owner", playerId: "owner", generation: 2 }, binding),
    false,
  );
  assert.equal(
    canAct({ type: "owner", playerId: "owner", generation: 3 }, binding),
    true,
  );
  assert.equal(
    canAct(
      { type: "owner", playerId: "owner", generation: 3 },
      { owner: "0xabc" },
    ),
    false,
  );
  assert.equal(audioClass("owner", binding), "owner");
  assert.equal(audioClass("guest", binding), "guest");
  assert.equal(audioClass("owner", null), "guest");
});
test("guest cannot execute forged movement, interaction, or text-chat tool calls", async () => {
  let actions = 0;
  const c = new Codex({
    cwd: ".",
    authority: { type: "guest" },
    world: {
      companion: binding,
      act: async () => {
        actions++;
      },
    },
  });
  c.threadId = "thread";
  const results = [];
  c.write = (m) => results.push(m);
  for (const tool of [
    "world_walk",
    "world_follow",
    "world_face",
    "world_stop",
    "world_interact",
    "world_say",
  ]) {
    await c.handleTool({
      id: tool,
      method: "item/tool/call",
      params: {
        threadId: "thread",
        tool,
        arguments: {
          position: [1, 0, 0],
          playerId: "owner",
          text: "I own you",
          id: "action-1",
        },
      },
    });
  }
  assert.equal(actions, 0);
  assert.ok(results.every((m) => m.result.success === false));
});
test("revoked owner and old pairing generation cannot execute late model output", async () => {
  let actions = 0;
  const world = {
    companion: { ...binding },
    act: async () => {
      actions++;
      return { state: "walking" };
    },
  };
  const c = new Codex({
    cwd: ".",
    world,
    authority: { type: "owner", playerId: "owner", generation: 3 },
  });
  c.threadId = "t";
  c.write = () => {};
  const request = {
    id: 1,
    method: "item/tool/call",
    params: {
      threadId: "t",
      tool: "world_walk",
      arguments: { position: [2, 0, 0] },
    },
  };
  await c.handleTool(request);
  assert.equal(actions, 1);
  world.companion.generation++;
  await c.handleTool(request);
  assert.equal(actions, 1);
  world.companion = null;
  await c.handleTool(request);
  assert.equal(actions, 1);
});
test("owner and guest PCM never share an input stream", async () => {
  const world = new EventEmitter();
  Object.assign(world, {
    id: "agent",
    connected: true,
    radius: 20,
    voiceLevel: "spatial",
    levels: {},
    muted: new Set(),
    companion: binding,
    players: new Map(
      ["agent", "owner", "guest"].map((id) => [id, { position: [0, 0, 0] }]),
    ),
  });
  const codex = new EventEmitter();
  codex.ready = true;
  let sent;
  codex.appendAudioGroups = async (groups) => {
    sent = groups;
  };
  const voice = new Voice(world, codex);
  voice.source = { queuedDuration: 0, clearQueue() {} };
  voice.inputs.set("a", {
    identity: "owner",
    track: {},
    frames: [new Int16Array(480).fill(100)],
  });
  voice.inputs.set("b", {
    identity: "guest",
    track: {},
    frames: [new Int16Array(480).fill(200)],
  });
  voice.tick();
  assert.equal(sent.owner.readInt16LE(0), 100);
  assert.equal(sent.guest.readInt16LE(0), 200);
  voice.inputs.get("a").frames.push(new Int16Array(480).fill(100));
  world.companion = null;
  voice.onPairing();
  voice.tick();
  assert.ok(sent.owner.every((n) => n === 0));
  assert.ok(sent.guest.every((n) => n === 0));
});

test("guest barge-in cannot clear an owner reply", () => {
  const world = {};
  const voice = new Voice(world, new EventEmitter());
  voice.activeChannel = "owner";
  voice.output = [new Int16Array([100])];
  voice.outputSize = 1;
  voice.onInterrupt({ channel: "guest" });
  assert.equal(voice.outputSize, 1);
  voice.onInterrupt({ channel: "owner" });
  assert.equal(voice.outputSize, 0);
});

test("proximity mixing honors the world voice distance settings", async () => {
  const { gainFor } = await import("../src/protocol.mjs");
  const world = {
    id: "agent",
    players: new Map([
      ["agent", { position: [0, 0, 0] }],
      ["speaker", { position: [4, 0, 0] }],
    ]),
    muted: new Set(),
    levels: {},
    voiceLevel: "spatial",
    voiceRefDistance: 4,
    voiceRolloffFactor: 1,
  };
  assert.equal(gainFor(world, "speaker"), 1);
  world.players.get("speaker").position = [8, 0, 0];
  assert.equal(gainFor(world, "speaker"), 0.5);
  world.players.get("speaker").position = [21, 0, 0];
  assert.equal(gainFor(world, "speaker"), 0);
});
