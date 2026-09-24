import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { encode, decode, validPosition, gainFor } from "./protocol.mjs";

export function parseEnvironment(source) {
  // Read the public configuration as data. Never execute a world's env.js.
  const raw = source.match(/globalThis\.env\s*=\s*(\{[^\n]*\})/)?.[1];
  const env = raw ? JSON.parse(raw) : {};
  for (const key of ["PUBLIC_JOIN_URL", "PUBLIC_WS_URL"]) {
    const value = source.match(
      new RegExp(`globalThis\\.env\\.${key}\\s*=\\s*("[^"\\n]*")`),
    )?.[1];
    if (value) env[key] = JSON.parse(value);
  }
  return env;
}
export async function resolveWorld(raw, fetcher = fetch) {
  const url = new URL(raw);
  if (["ws:", "wss:"].includes(url.protocol))
    return { wsUrl: url.toString(), instanceId: null };
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Use an HTTPS world URL or a direct WebSocket URL.");
  const response = await fetcher(new URL("env.js", url), {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(`World configuration returned HTTP ${response.status}`);
  const env = parseEnvironment(await response.text());
  if (env.PUBLIC_JOIN_URL) {
    const joined = await fetcher(new URL(env.PUBLIC_JOIN_URL, url), {
      method: "POST",
      headers: { "x-lobby-tab": randomUUID() },
      signal: AbortSignal.timeout(45000),
    });
    const data = await joined.json();
    if (!joined.ok || !data.wsUrl || !data.ticket)
      throw new Error(`World join failed: ${data.error || joined.status}`);
    const target = new URL(data.wsUrl);
    target.searchParams.set("admissionTicket", data.ticket);
    return { wsUrl: target.toString(), instanceId: data.instanceId };
  }
  if (!env.PUBLIC_WS_URL)
    throw new Error(
      "World has no PUBLIC_WS_URL. Supply a direct WebSocket URL.",
    );
  return {
    wsUrl: new URL(env.PUBLIC_WS_URL, url).toString(),
    instanceId: null,
  };
}

export class World extends EventEmitter {
  constructor({ radius = 20 } = {}) {
    super();
    this.radius = radius;
    this.players = new Map();
    this.levels = {};
    this.muted = new Set();
    this.voiceLevel = "disabled";
    this.connected = false;
  }
  async connect({ url, name }) {
    const target = await resolveWorld(url);
    this.instanceId = target.instanceId;
    const wsUrl = new URL(target.wsUrl);
    wsUrl.searchParams.set("name", name);
    const ws = (this.ws = new WebSocket(wsUrl, {
      maxPayload: 32 * 1024 * 1024,
    }));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("World snapshot timed out"));
        ws.terminate();
      }, 30000);
      const finish = (error) => {
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      ws.on("message", (bytes) => {
        try {
          const [type, data] = decode(bytes);
          this.receive(type, data);
          if (type === "snapshot") finish();
        } catch (error) {
          finish(error);
          this.emit("failure", error);
        }
      });
      ws.on("error", () => {
        const error = new Error("World WebSocket failed");
        finish(error);
        this.emit("failure", error);
      });
      ws.on("close", () => {
        this.connected = false;
        finish(new Error("World disconnected"));
        this.emit("failure", new Error("World disconnected"));
      });
    });
    this.ping = setInterval(() => this.send("ping", Date.now()), 10000);
  }
  receive(type, data) {
    if (type === "snapshot") {
      this.id = data.id;
      this.connected = true;
      this.players = new Map(
        data.entities.filter((e) => e.type === "player").map((e) => [e.id, e]),
      );
      this.livekit = data.livekit;
      this.voiceLevel = data.settings?.voice || "disabled";
      this.voiceRefDistance = data.settings?.voiceRefDistance;
      this.voiceRolloffFactor = data.settings?.voiceRolloffFactor;
      this.levels = data.livekit?.levels || {};
      this.muted = new Set(data.livekit?.muted || []);
    }
    if (type === "entityAdded" && data.type === "player")
      this.players.set(data.id, data);
    if (type === "entityRemoved") this.players.delete(data);
    if (type === "entityModified" && this.players.has(data.id)) {
      const player = this.players.get(data.id);
      Object.assign(player, data);
      if (data.p) player.position = data.p;
      if (data.q) player.quaternion = data.q;
    }
    if (type === "playerTeleport" && validPosition(data.position))
      this.setPosition(data.position);
    if (type === "liveKitLevel") this.levels[data.playerId] = data.level;
    if (type === "mute")
      data.muted
        ? this.muted.add(data.playerId)
        : this.muted.delete(data.playerId);
    if (type === "settingsModified" && data.key === "voice")
      this.voiceLevel = data.value;
    if (
      type === "settingsModified" &&
      ["voiceRefDistance", "voiceRolloffFactor"].includes(data.key)
    )
      this[data.key] = data.value;
    if (type === "kick")
      this.emit(
        "failure",
        new Error(`World kicked the agent: ${String(data)}`),
      );
    this.emit("update", { type, data });
  }
  send(type, data) {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(encode(type, data));
  }
  setPosition(position) {
    if (!validPosition(position))
      throw new Error("Position must be three finite world coordinates.");
    if (!this.connected) throw new Error("World is disconnected.");
    this.players.get(this.id).position = [...position];
    this.send("entityModified", { id: this.id, p: position, t: true });
  }
  say(body) {
    if (typeof body !== "string" || !body.trim() || body.length > 1500)
      throw new Error("Chat text must be 1–1500 characters.");
    if (!this.connected) throw new Error("World is disconnected.");
    this.send("chatAdded", {
      id: randomUUID(),
      from: this.players.get(this.id)?.name,
      fromId: this.id,
      body,
      createdAt: new Date().toISOString(),
    });
  }
  status() {
    return {
      connected: this.connected,
      playerId: this.id,
      instanceId: this.instanceId,
      position: this.players.get(this.id)?.position,
      voiceLevel: this.levels[this.id] || this.voiceLevel,
      muted: this.muted.has(this.id),
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        position: p.position,
        audible: gainFor(this, p.id, this.radius) > 0,
      })),
    };
  }
  close() {
    clearInterval(this.ping);
    this.connected = false;
    this.ws?.close();
  }
}
