import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Codex } from "./codex.mjs";

// Each role has its own history and tool set. Guest speech never enters an
// owner-capable model, including while a pairing is changing.
export class Conversations extends EventEmitter {
  constructor({
    cwd,
    world,
    bin = "codex",
    create = (options) => new Codex(options),
  }) {
    super();
    Object.assign(this, { cwd, world, bin, create });
    this.sessions = new Map();
    this.options = {};
    this.ownerKey = "";
    this.onPairing = () => {
      void this.pair().catch((error) => this.emit("failure", error));
    };
  }
  get ready() {
    return !!this.sessions.get("guest")?.ready;
  }
  get threadId() {
    return (
      this.sessions.get("owner")?.threadId ||
      this.sessions.get("guest")?.threadId
    );
  }
  get lastTranscript() {
    return this.transcript || null;
  }
  status() {
    return Object.fromEntries(
      [...this.sessions].map(([role, session]) => [
        role,
        { ready: session.ready, threadId: session.threadId },
      ]),
    );
  }
  async createSession(role, authority) {
    const cwd = join(this.cwd, role);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    if (this.closing) return null;
    if (
      role === "owner" &&
      this.ownerKey !== `${authority.playerId}:${authority.generation}`
    )
      return null;
    const session = this.create({
      cwd,
      world: this.world,
      bin: this.bin,
      authority,
    });
    const active = () => !this.closing && this.sessions.get(role) === session;
    session.on("thread/realtime/outputAudio/delta", (event) => {
      if (active())
        this.emit("thread/realtime/outputAudio/delta", {
          ...event,
          channel: role,
        });
    });
    session.on("thread/realtime/transcript/done", (event) => {
      if (active()) this.transcript = { ...event, channel: role };
    });
    session.on("interrupted", () => {
      if (active()) this.emit("interrupted", { channel: role });
    });
    session.on("failure", (error) => {
      if (active()) this.emit("failure", error);
    });
    this.sessions.set(role, session);
    try {
      await session.start(this.options);
    } catch (error) {
      await session.close();
      throw error;
    }
    if (!active()) await session.close();
    return session;
  }
  async start(options) {
    this.options = options;
    await this.createSession("guest", { type: "guest" });
    this.world.on("pairing", this.onPairing);
    await this.pair();
  }
  async pair() {
    const binding = this.world.companion;
    const key = binding?.ownerPlayerId
      ? `${binding.ownerPlayerId}:${binding.generation}`
      : "";
    if (this.ownerKey === key) return;
    this.ownerKey = key;
    const previous = this.sessions.get("owner");
    this.sessions.delete("owner");
    this.emit("interrupted");
    await this.world.act("stop");
    await previous?.close();
    if (this.closing || this.ownerKey !== key || !key) return;
    try {
      await this.createSession("owner", {
        type: "owner",
        playerId: binding.ownerPlayerId,
        generation: binding.generation,
      });
    } catch (error) {
      if (!this.closing && this.ownerKey === key) throw error;
    }
  }
  async appendAudioGroups({ owner, guest }) {
    await Promise.all([
      this.sessions.get("guest")?.appendAudio(guest),
      this.sessions.get("owner")?.appendAudio(owner),
    ]);
  }
  async text(text) {
    if (!this.localStarting)
      this.localStarting = this.createSession("local", { type: "local" });
    return (await this.localStarting).text(text);
  }
  async close() {
    this.closing = true;
    this.world.off("pairing", this.onPairing);
    await Promise.allSettled(
      [...this.sessions.values()].map((session) => session.close()),
    );
    this.sessions.clear();
  }
}
