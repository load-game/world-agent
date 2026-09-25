import { EventEmitter } from "node:events";
import { audioClass, canAct } from "./authority.mjs";

const commands = new Map([
  ["listen to me", "owner"],
  ["mute others", "owner"],
  ["deafen", "deafened"],
  ["listen to everyone", "everyone"],
  ["unmute everyone", "everyone"],
]);
export function chatListeningCommand(text) {
  if (typeof text !== "string" || text.length > 80) return null;
  return (
    commands.get(
      text
        .trim()
        .toLowerCase()
        .replace(/[.!?]+$/, ""),
    ) || null
  );
}

// This policy only controls this companion's input, never other players' mics.
export class Listening extends EventEmitter {
  constructor(world) {
    super();
    this.world = world;
    this.mode = "everyone";
    this.muted = new Set();
    this.revision = 0;
  }
  allowsRole(role) {
    return (
      role === "local" ||
      (this.mode !== "deafened" &&
        (role === "owner" || this.mode === "everyone"))
    );
  }
  allows(identity) {
    return (
      this.allowsRole(audioClass(identity, this.world.companion)) &&
      !this.muted.has(identity)
    );
  }
  status() {
    return {
      mode: this.mode,
      mutedPlayers: [...this.muted],
      chatControls: !!this.world.authenticatedChat,
    };
  }
  change(options, authority) {
    if (!canAct(authority, this.world.companion))
      throw new Error("Verified owner required");
    const { mode, playerId, muted } = options;
    if (mode !== undefined) {
      if (!["everyone", "owner", "deafened"].includes(mode))
        throw new Error("Unknown listening mode");
      if (playerId !== undefined || muted !== undefined)
        throw new Error("Choose mode or player mute, not both");
      if (this.mode === mode && (mode === "deafened" || this.muted.size === 0))
        return this.status();
      this.mode = mode;
      if (mode === "everyone" || mode === "owner") this.muted.clear();
    } else {
      if (
        typeof playerId !== "string" ||
        typeof muted !== "boolean" ||
        !this.world.players.has(playerId)
      )
        throw new Error("Choose a connected player and mute state");
      if (
        playerId === this.world.companion?.ownerPlayerId ||
        playerId === this.world.id
      )
        throw new Error("Use deafen to stop hearing the owner");
      if (muted) this.muted.add(playerId);
      else this.muted.delete(playerId);
    }
    this.revision++;
    this.emit("change", { authority });
    return this.status();
  }
  chat(message) {
    if (!this.world.authenticatedChat || message.authenticated !== true)
      return false;
    const mode = chatListeningCommand(message.body);
    const authority = {
      type: "owner",
      playerId: message.fromId,
      generation: message.generation,
    };
    if (!mode || !canAct(authority, this.world.companion)) return false;
    this.change({ mode }, authority);
    return true;
  }
}
