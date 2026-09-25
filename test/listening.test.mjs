import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Listening, chatListeningCommand } from "../src/listening.mjs";
import { Voice } from "../src/audio.mjs";
import { Codex } from "../src/codex.mjs";
import { parseArgs } from "../src/cli.mjs";
const owner = { type: "owner", playerId: "owner", generation: 1 };
function world() {
  return Object.assign(new EventEmitter(), {
    id: "agent",
    connected: true,
    authenticatedChat: true,
    companion: { ownerPlayerId: "owner", generation: 1 },
    players: new Map(
      ["agent", "owner", "guest", "newcomer"].map((id) => [
        id,
        { position: [0, 0, 0] },
      ]),
    ),
    radius: 20,
    voiceLevel: "spatial",
    muted: new Set(),
    levels: {},
    verifyOwner: async () => {},
  });
}
test("owner-only listening includes future speakers; deafen silences owner; restore clears individual mutes", () => {
  const l = new Listening(world());
  assert.equal(l.allows("guest"), true);
  l.change({ playerId: "guest", muted: true }, owner);
  assert.equal(l.allows("guest"), false);
  assert.equal(l.allows("owner"), true);
  l.change({ mode: "owner" }, owner);
  assert.equal(l.allows("newcomer"), false);
  assert.equal(l.allows("owner"), true);
  l.change({ mode: "deafened" }, owner);
  assert.equal(l.allows("owner"), false);
  l.change({ mode: "everyone" }, owner);
  assert.equal(l.allows("guest"), true);
  assert.throws(
    () => l.change({ playerId: "owner", muted: true }, owner),
    /deafen/,
  );
  assert.throws(
    () => l.change({ mode: "owner" }, { type: "guest" }),
    /Verified/,
  );
  assert.throws(
    () => l.change({ mode: "owner" }, { ...owner, generation: 0 }),
    /Verified/,
  );
});
test("only exact commands from authenticated current owner chat can wake; text never runs tasks", () => {
  const w = world(),
    l = new Listening(w);
  l.change({ mode: "deafened" }, owner);
  const msg = {
    fromId: "owner",
    body: "Listen to me!",
    generation: 1,
    authenticated: true,
  };
  for (const change of [
    { fromId: "guest" },
    { generation: 0 },
    { authenticated: false },
    { body: "listen to me and write a file" },
    { body: "please run npm test" },
  ]) {
    assert.equal(l.chat({ ...msg, ...change }), false);
    assert.equal(l.mode, "deafened");
  }
  w.authenticatedChat = false;
  assert.equal(l.chat(msg), false);
  w.authenticatedChat = true;
  assert.equal(l.chat(msg), true);
  assert.equal(l.mode, "owner");
  assert.equal(chatListeningCommand("deafen"), "deafened");
  assert.equal(chatListeningCommand("unmute everyone"), "everyone");
  w.companion = null;
  assert.equal(l.chat(msg), false);
});
test("muted microphone PCM is dropped before mixing and cannot interrupt owner output", () => {
  const w = world(),
    c = new EventEmitter();
  c.listening = new Listening(w);
  c.ready = true;
  let sent;
  c.appendAudioGroups = async (groups) => {
    sent = groups;
  };
  const v = new Voice(w, c);
  v.source = { queuedDuration: 0, clearQueue() {} };
  v.inputs.set("guest", {
    identity: "guest",
    track: {},
    frames: [new Int16Array(480).fill(3000)],
  });
  v.activeChannel = "owner";
  v.outputSize = 10;
  v.tick();
  assert.equal(v.outputSize, 10);
  c.listening.change({ mode: "owner" }, owner);
  v.inputs.get("guest").frames.push(new Int16Array(480).fill(3000));
  v.tick();
  assert.ok(sent.guest.every((b) => b === 0));
  assert.equal(v.inputs.get("guest").frames.length, 0);
  c.listening.change({ mode: "deafened" }, owner);
  v.inputs.set("owner", {
    identity: "owner",
    track: {},
    frames: [new Int16Array(480).fill(3000)],
  });
  v.tick();
  assert.ok(sent.owner.every((b) => b === 0));
});
test("project permission is opt-in with an owner and explicit path", () => {
  assert.equal(parseArgs([]).options.permissions, "read-only");
  assert.throws(
    () => parseArgs(["--permissions", "danger-full-access"]),
    /Permissions/,
  );
  assert.throws(
    () => parseArgs(["--permissions", "workspace-write"]),
    /requires/,
  );
  const options = parseArgs([
    "--permissions",
    "workspace-write",
    "--owner",
    "0x" + "11".repeat(20),
    "--project",
    "/tmp/project",
  ]).options;
  assert.equal(options.project, "/tmp/project");
});
test("project commands require owner audio, live pairing and explicit permission, even when forged", async () => {
  const w = world(),
    listening = new Listening(w),
    requests = [];
  const c = new Codex({
    cwd: ".",
    world: w,
    authority: owner,
    listening,
    project: "/project",
    permissions: "workspace-write",
  });
  c.request = async (method, args) => {
    requests.push({ method, args });
    return { exitCode: 0 };
  };
  await assert.rejects(c.runProject("touch proof"), /microphone/);
  c.heardVoice = true;
  await c.runProject("touch proof");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].args.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: ["/project"],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  });
  assert.equal(requests[0].args.cwd, "/project");
  await assert.rejects(c.text("touch from-chat"), /microphone/);
  for (const type of ["guest", "local"]) {
    c.authority = { ...owner, type };
    assert.equal(
      c.toolSpecs().some((t) => t.name === "project_run"),
      false,
    );
    await assert.rejects(c.runProject("touch forged"), /microphone/);
  }
  c.authority = owner;
  c.permissions = "read-only";
  await assert.rejects(c.runProject("touch forged"), /microphone/);
  c.permissions = "workspace-write";
  w.companion.generation++;
  await assert.rejects(c.runProject("touch stale"), /microphone/);
  assert.equal(requests.length, 1);
});
test("revocation or deafen while fresh owner verification is pending blocks the command", async () => {
  for (const revoke of [true, false]) {
    const w = world(),
      listening = new Listening(w);
    let release,
      commands = 0;
    w.verifyOwner = () =>
      new Promise((r) => {
        release = r;
      });
    const c = new Codex({
      cwd: ".",
      world: w,
      authority: owner,
      listening,
      project: "/project",
      permissions: "workspace-write",
    });
    c.heardVoice = true;
    c.request = async () => {
      commands++;
    };
    const pending = c.runProject("touch late");
    if (revoke) w.companion.generation++;
    else listening.change({ mode: "deafened" }, owner);
    release();
    await assert.rejects(pending, /authority changed/);
    assert.equal(commands, 0);
  }
});
