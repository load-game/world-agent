import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Codex } from "./codex.mjs";
import { Listening } from "./listening.mjs";
import { canAct } from "./authority.mjs";

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
    this.starting = new Map();
    this.retiring = new Set();
    this.listening = new Listening(world);
    this.onListening = ({ authority }) => {
      const revision = this.listening.revision;
      this.retire("guest");
      if (!this.listening.allowsRole("owner")) this.retire("owner");
      this.emit("interrupted");
      void this.ensureVoice()
        .then(async () => {
          if (
            this.closing ||
            this.listening.revision !== revision ||
            !canAct(authority, this.world.companion)
          )
            return;
          const text =
            this.listening.mode === "deafened"
              ? 'Deafened. Type "listen to me" in game chat to wake me, or use ./connect listen owner.'
              : this.listening.mode === "owner"
                ? "Ready. I am listening only to you."
                : "Ready. I am listening to unmuted nearby participants.";
          // Static acknowledgement only. Chat is never passed to a model.
          await this.world.act("say", text, authority).catch(() => {});
        })
        .catch((error) => this.emit("failure", error));
    };
    this.onChat = (message) => this.listening.chat(message);
    this.options = {};
    this.ownerKey = "";
    this.onPairing = () => {
      void this.pair().catch((error) => this.emit("failure", error));
    };
  }
  get ready() {
    return (
      this.listening.mode === "deafened" ||
      [...this.sessions.values()].some((s) => s.ready)
    );
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
    const token = {};
    this.starting.set(role, token);
    const cwd = join(this.cwd, role);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    if (
      this.closing ||
      this.starting.get(role) !== token ||
      !this.listening.allowsRole(role)
    )
      return null;
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
      listening: this.listening,
      project: role === "owner" ? this.options.project : undefined,
      permissions: role === "owner" ? this.options.permissions : "read-only",
      isActive: () => active(),
    });
    const active = () =>
      !this.closing &&
      this.listening.allowsRole(role) &&
      this.sessions.get(role) === session;
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
      if (active()) throw error;
    }
    if (!active()) await session.close();
    return session;
  }
  async start(options) {
    this.options = options;
    this.listening.on("change", this.onListening);
    this.world.on("chat", this.onChat);
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
    const retired = this.retire("owner");
    this.emit("interrupted");
    await this.world.act("stop");
    await retired;
    if (
      this.closing ||
      this.ownerKey !== key ||
      !key ||
      !this.listening.allowsRole("owner")
    )
      return;
    try {
      await this.ensureVoice();
    } catch (error) {
      if (!this.closing && this.ownerKey === key) throw error;
    }
  }
  retire(role) {
    this.starting.delete(role);
    const session = this.sessions.get(role);
    this.sessions.delete(role);
    if (!session) return Promise.resolve();
    const closing = session.close();
    this.retiring.add(closing);
    void closing.finally(() => this.retiring.delete(closing)).catch(() => {});
    return closing;
  }
  async ensureVoice() {
    if (this.closing) return;
    const tasks = [];
    if (
      this.listening.allowsRole("guest") &&
      !this.sessions.has("guest") &&
      !this.starting.has("guest")
    )
      tasks.push(this.createSession("guest", { type: "guest" }));
    const binding = this.world.companion;
    if (
      this.listening.allowsRole("owner") &&
      binding?.ownerPlayerId &&
      !this.sessions.has("owner") &&
      !this.starting.has("owner")
    )
      tasks.push(
        this.createSession("owner", {
          type: "owner",
          playerId: binding.ownerPlayerId,
          generation: binding.generation,
        }),
      );
    await Promise.all(tasks);
  }
  async appendAudioGroups({ owner, guest }) {
    await Promise.all([
      this.listening.allowsRole("guest") &&
        this.sessions.get("guest")?.appendAudio(guest),
      this.listening.allowsRole("owner") &&
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
    this.world.off("chat", this.onChat);
    this.listening.off("change", this.onListening);
    this.starting.clear();
    await Promise.allSettled([
      ...this.retiring,
      ...[...this.sessions.values()].map((session) => session.close()),
    ]);
    this.sessions.clear();
  }
}
