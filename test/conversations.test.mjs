import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversations } from "../src/conversations.mjs";

test("pairing replacement closes old authority and keeps guest, owner and local history separate", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "companion-"));
  const world = new EventEmitter();
  let stops = 0;
  world.act = async () => {
    stops++;
  };
  const created = [];
  const conversations = new Conversations({
    cwd,
    world,
    create: (options) => {
      const session = new EventEmitter();
      Object.assign(session, {
        authority: options.authority,
        inputs: [],
        ready: false,
      });
      session.start = async () => {
        session.ready = true;
      };
      session.close = async () => {
        session.ready = false;
        session.closed = true;
      };
      session.appendAudio = async (audio) => session.inputs.push(audio);
      session.text = async (text) => {
        session.prompt = text;
      };
      created.push(session);
      return session;
    },
  });
  try {
    await conversations.start({});
    world.companion = { ownerPlayerId: "owner", generation: 1 };
    await conversations.pair();
    await conversations.appendAudioGroups({
      owner: "private owner audio",
      guest: "untrusted guest audio",
    });
    await conversations.text("local command");
    assert.deepEqual(
      created.map((s) => s.authority.type),
      ["guest", "owner", "local"],
    );
    assert.deepEqual(created[0].inputs, ["untrusted guest audio"]);
    assert.deepEqual(created[1].inputs, ["private owner audio"]);
    assert.deepEqual(created[2].inputs, []);
    world.companion = { ownerPlayerId: null, generation: 2 };
    await conversations.pair();
    assert.equal(created[1].closed, true);
    assert.equal(conversations.sessions.has("owner"), false);
    world.companion = { ownerPlayerId: "owner", generation: 3 };
    await conversations.pair();
    assert.equal(created[3].authority.generation, 3);
    assert.deepEqual(created[3].inputs, []);
    assert.equal(stops, 3);
  } finally {
    await conversations.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("revocation while an owner session starts discards its output and never restores authority", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "companion-race-"));
  const world = new EventEmitter();
  world.act = async () => {};
  let release, starting;
  const started = new Promise((r) => (starting = r));
  const c = new Conversations({
    cwd,
    world,
    create: ({ authority }) => {
      const s = new EventEmitter();
      s.start = async () => {
        if (authority.type === "owner") {
          starting(s);
          await new Promise((r) => (release = r));
        }
        s.ready = true;
      };
      s.close = async () => {
        s.ready = false;
        s.closed = true;
      };
      return s;
    },
  });
  try {
    await c.start({});
    world.companion = { ownerPlayerId: "owner", generation: 1 };
    const pairing = c.pair();
    const stale = await started;
    world.companion = null;
    await c.pair();
    release();
    await pairing;
    let outputs = 0;
    c.on("thread/realtime/outputAudio/delta", () => outputs++);
    stale.emit("thread/realtime/outputAudio/delta", {});
    assert.equal(outputs, 0);
    assert.equal(c.sessions.has("owner"), false);
    assert.equal(stale.closed, true);
  } finally {
    await c.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("deafen closes both audio histories; authenticated owner chat wakes a fresh owner-only session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "companion-listening-"));
  const world = Object.assign(new EventEmitter(), {
    authenticatedChat: true,
    companion: { ownerPlayerId: "owner", generation: 1 },
    act: async () => {},
    players: new Map(),
  });
  const created = [];
  const c = new Conversations({
    cwd,
    world,
    create: (options) => {
      const s = Object.assign(new EventEmitter(), {
        ...options,
        inputs: [],
        ready: false,
      });
      s.start = async () => {
        s.ready = true;
      };
      s.close = async () => {
        s.ready = false;
        s.closed = true;
      };
      s.appendAudio = async (value) => s.inputs.push(value);
      s.text = async () => {};
      created.push(s);
      return s;
    },
  });
  try {
    await c.start({ permissions: "workspace-write", project: "/project" });
    await c.text("local context");
    assert.equal(
      created.find((s) => s.authority.type === "guest").permissions,
      "read-only",
    );
    assert.equal(
      created.find((s) => s.authority.type === "local").project,
      undefined,
    );
    assert.equal(
      created.find((s) => s.authority.type === "owner").permissions,
      "workspace-write",
    );
    const oldOwner = c.sessions.get("owner"),
      oldGuest = c.sessions.get("guest");
    c.listening.change({ mode: "deafened" }, oldOwner.authority);
    assert.equal(c.sessions.has("owner"), false);
    assert.equal(c.sessions.has("guest"), false);
    assert.equal(oldOwner.closed, true);
    assert.equal(oldGuest.closed, true);
    await c.appendAudioGroups({ owner: "secret", guest: "noise" });
    assert.deepEqual(oldOwner.inputs, []);
    let output = 0;
    c.on("thread/realtime/outputAudio/delta", () => output++);
    oldOwner.emit("thread/realtime/outputAudio/delta", {});
    oldGuest.emit("thread/realtime/outputAudio/delta", {});
    assert.equal(output, 0);
    world.emit("chat", {
      body: "listen to me",
      fromId: "guest",
      generation: 1,
      authenticated: true,
    });
    assert.equal(c.listening.mode, "deafened");
    world.emit("chat", {
      body: "listen to me",
      fromId: "owner",
      generation: 1,
      authenticated: true,
    });
    for (let i = 0; i < 50 && !c.sessions.get("owner")?.ready; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(c.listening.mode, "owner");
    assert.ok(c.sessions.get("owner")?.ready);
    assert.notEqual(c.sessions.get("owner"), oldOwner);
    assert.equal(c.sessions.has("guest"), false);
    assert.deepEqual(c.sessions.get("owner").inputs, []);
  } finally {
    await c.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
