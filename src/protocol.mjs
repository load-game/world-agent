import { Packr } from "msgpackr";
// Wire IDs from load-game/gamedev packages/core/packets.js. Append-only upstream.
export const packets = [
  "snapshot",
  "command",
  "chatAdded",
  "chatCleared",
  "blueprintAdded",
  "blueprintModified",
  "entityAdded",
  "entityModified",
  "entityEvent",
  "entityRemoved",
  "playerTeleport",
  "playerPush",
  "playerSessionAvatar",
  "playerAvatar",
  "liveKitLevel",
  "livekitLeave",
  "livekitToken",
  "mute",
  "settingsModified",
  "spawnModified",
  "modifyRank",
  "kick",
  "ping",
  "pong",
  "blueprintRemoved",
];
const codec = new Packr({ structuredClone: true });
export function encode(name, data) {
  const id = packets.indexOf(name);
  if (id < 0) throw new Error(`Unknown packet: ${name}`);
  return codec.pack([id, data]);
}
export function decode(bytes) {
  const [id, data] = codec.unpack(bytes);
  return [packets[id], data];
}
export function validPosition(p) {
  return (
    Array.isArray(p) &&
    p.length === 3 &&
    p.every((n) => Number.isFinite(n) && Math.abs(n) < 100000)
  );
}
export function gainFor(world, id, radius = 20) {
  const player = world.players.get(id),
    self = world.players.get(world.id);
  if (id === world.id || !player || !self || world.muted.has(id)) return 0;
  const level = world.levels[id] || world.voiceLevel;
  if (level === "disabled") return 0;
  if (level === "global") return 1;
  if (
    level !== "spatial" ||
    !validPosition(player.position) ||
    !validPosition(self.position)
  )
    return 0;
  const distance = Math.hypot(
    ...player.position.map((n, i) => n - self.position[i]),
  );
  // Engine inverse attenuation, with a hard listening boundary for this agent.
  const ref =
    Number.isFinite(world.voiceRefDistance) && world.voiceRefDistance > 0
      ? world.voiceRefDistance
      : 1;
  const rolloff =
    Number.isFinite(world.voiceRolloffFactor) && world.voiceRolloffFactor >= 0
      ? world.voiceRolloffFactor
      : 3;
  return distance > radius
    ? 0
    : ref / (ref + rolloff * (Math.max(ref, distance) - ref));
}
