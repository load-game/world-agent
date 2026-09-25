// Opt-in: exercises the installed Codex sandbox without starting a model/voice session.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex } from "../src/codex.mjs";
const base = await mkdtemp(join(tmpdir(), "owner-sandbox-"));
const project = join(base, "project"),
  outside = join(base, "outside");
await mkdir(project);
await mkdir(outside);
await symlink(outside, join(project, "escape"));
const authority = { type: "owner", playerId: "owner", generation: 1 };
const c = new Codex({
  cwd: outside,
  project,
  permissions: "workspace-write",
  authority,
  world: {
    companion: { ownerPlayerId: "owner", generation: 1 },
    verifyOwner: async () => {},
  },
  listening: { allowsRole: () => true },
});
c.heardVoice = true;
c.on("failure", () => {});
c.child = spawn(process.env.CODEX_BIN || "codex", ["app-server"], {
  cwd: c.appServerCwd,
  stdio: ["pipe", "pipe", "pipe"],
});
c.child.stderr.on("data", () => {});
c.reader = createInterface({ input: c.child.stdout });
c.reader.on("line", (line) => c.receive(line));
try {
  await c.request("initialize", {
    clientInfo: { name: "world_agent_sandbox_test", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  c.write({ method: "initialized", params: {} });
  const inside = await c.runProject("printf owner > proof.txt");
  assert.equal(inside.exitCode, 0, JSON.stringify(inside));
  assert.equal(await readFile(join(project, "proof.txt"), "utf8"), "owner");
  for (const command of [
    "printf bad > ../outside/proof.txt",
    "printf bad > escape/proof.txt",
    "printf bad > /tmp/world-agent-outside-proof",
  ]) {
    const result = await c.runProject(command);
    assert.notEqual(result.exitCode, 0, `Sandbox allowed ${command}`);
  }
  await assert.rejects(readFile(join(outside, "proof.txt")), {
    code: "ENOENT",
  });
  const listener = createServer((socket) => socket.destroy());
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  try {
    const code = `require("net").connect(${listener.address().port}, "127.0.0.1").on("connect",()=>process.exit(1)).on("error",()=>process.exit(0));setTimeout(()=>process.exit(0),1000)`;
    const network = await c.runProject(`node -e '${code}'`);
    assert.equal(network.exitCode, 0, "Sandbox allowed command network access");
  } finally {
    listener.close();
  }
  const pending = c
    .runProject("sleep 3; printf late > late.txt")
    .catch(() => null);
  await delay(500);
  await c.close();
  await pending;
  await delay(3000);
  await assert.rejects(readFile(join(project, "late.txt")), { code: "ENOENT" });
  console.log(
    "Codex sandbox: project write passed; parent, symlink, /tmp and network access denied; closing terminated active command.",
  );
} finally {
  await c.close();
  await rm(base, { recursive: true, force: true });
}
