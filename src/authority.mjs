export const READ_TOOLS = new Set([
  "world_status",
  "world_observe",
  "world_view",
]);
export function canAct(authority, binding) {
  if (authority?.type === "local") return true;
  return (
    authority?.type === "owner" &&
    !!binding?.ownerPlayerId &&
    authority.playerId === binding.ownerPlayerId &&
    authority.generation === binding.generation
  );
}
export function audioClass(identity, binding) {
  return identity === binding?.ownerPlayerId ? "owner" : "guest";
}
