#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { World } from "./world.mjs";
import { Codex } from "./codex.mjs";
import { Voice } from "./audio.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url))),
  local = join(root, ".local");
const stateFile = join(local, "connection.json"),
  lockFile = join(local, "lock.json");
export function parseArgs(argv) {
  const options = {
    url: process.env.WORLD_URL || "https://devnet.load.game/",
    name: "Codex",
    radius: 20,
    voice: "ember",
  };
  const rest = argv[0] === "--help" ? ["help"] : [...argv];
  const command = rest[0] && !rest[0].startsWith("--") ? rest.shift() : "start";
  if (
    !["start", "run", "status", "stop", "say", "move", "text", "help"].includes(
      command,
    )
  )
    throw new Error(`Unknown command: ${command}`);
  if (["say", "text", "move"].includes(command))
    return { command, options, values: rest };
  while (rest.length) {
    const flag = rest.shift(),
      value = rest.shift();
    if (!["--url", "--name", "--radius", "--voice"].includes(flag) || !value)
      throw new Error(`Unknown or incomplete option: ${flag}`);
    options[flag.slice(2)] = flag === "--radius" ? Number(value) : value;
  }
  if (
    !Number.isFinite(options.radius) ||
    options.radius <= 0 ||
    options.radius > 40
  )
    throw new Error("Radius must be greater than 0 and at most 40 meters.");
  if (!options.name.trim() || options.name.length > 64)
    throw new Error("Name must be 1–64 characters.");
  new URL(options.url);
  return { command, options };
}
async function control(action, args = {}) {
  let state;
  try {
    state = JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    throw new Error("Agent is not connected. Run ./connect.");
  }
  const response = await fetch(`http://127.0.0.1:${state.port}/control`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${state.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ action, ...args }),
    signal: AbortSignal.timeout(action === "text" ? 130000 : 10000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Control request failed");
  return result;
}
async function acquireLock() {
  await mkdir(local, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(lockFile, "wx", 0o600);
      await file.writeFile(JSON.stringify({ pid: process.pid }));
      await file.close();
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const lock = JSON.parse(await readFile(lockFile, "utf8"));
      try {
        process.kill(lock.pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") {
          await unlink(lockFile);
          continue;
        }
        throw e;
      }
      throw new Error(
        "An agent is already running or starting. Use ./connect status or ./connect stop.",
      );
    }
  }
  throw new Error("Could not acquire connection lock.");
}
async function run(options) {
  await acquireLock();
  const world = new World({ radius: options.radius });
  const cwd = join(local, "operator");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const codex = new Codex({
    cwd,
    world,
    bin: process.env.CODEX_BIN || "codex",
  });
  const voice = new Voice(world, codex);
  let server,
    closing = false;
  const cleanup = async (error) => {
    if (closing) return;
    closing = true;
    if (error) {
      console.error(error.message);
      process.send?.({ error: error.message });
    }
    const force = setTimeout(() => process.exit(error ? 1 : 0), 5000);
    force.unref();
    server?.close();
    await Promise.allSettled([voice.close(), codex.close()]);
    world.close();
    await Promise.allSettled([unlink(stateFile), unlink(lockFile)]);
    process.exit(error ? 1 : 0);
  };
  for (const system of [world, codex, voice])
    system.on("failure", (error) => {
      void cleanup(error);
    });
  process.once("SIGTERM", () => {
    void cleanup();
  });
  process.once("SIGINT", () => {
    void cleanup();
  });
  const snapshot = () => ({
    ...world.status(),
    voiceConnected: !!voice.connected,
    realtimeConnected: !!codex.ready,
    threadId: codex.threadId,
    radius: options.radius,
    audio: voice.stats,
    lastTranscript: codex.lastTranscript || null,
  });
  try {
    await world.connect(options);
    if (!world.livekit)
      throw new Error("The world did not advertise voice support.");
    await codex.start(options);
    await voice.start();
    if (closing) return;
    const token = randomBytes(32).toString("hex");
    server = createServer(async (req, res) => {
      const respond = (status, body) => {
        res.writeHead(status, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(body));
      };
      const given = Buffer.from(req.headers.authorization || ""),
        expected = Buffer.from(`Bearer ${token}`);
      if (
        req.method !== "POST" ||
        req.url !== "/control" ||
        given.length !== expected.length ||
        !timingSafeEqual(given, expected)
      ) {
        respond(403, { error: "Denied" });
        return;
      }
      try {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 8192) throw new Error("Request too large");
        }
        const data = JSON.parse(body);
        if (data.action === "status") respond(200, snapshot());
        else if (data.action === "stop") {
          respond(200, { stopped: true });
          setImmediate(() => {
            void cleanup();
          });
        } else if (data.action === "say") {
          world.say(data.text);
          respond(200, { sent: true });
        } else if (data.action === "move") {
          world.setPosition(data.position);
          respond(200, snapshot());
        } else if (data.action === "text") {
          if (
            typeof data.text !== "string" ||
            !data.text.trim() ||
            data.text.length > 4000
          )
            throw new Error("Text must be 1–4000 characters.");
          await codex.text(data.text);
          respond(200, { sent: true });
        } else respond(400, { error: "Unknown action" });
      } catch (error) {
        respond(400, { error: error.message });
      }
    });
    server.requestTimeout = 10000;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    await writeFile(
      stateFile,
      JSON.stringify({ port: server.address().port, token }),
      { mode: 0o600 },
    );
    const status = snapshot();
    if (process.send && process.connected) {
      process.send({ ready: status });
      process.disconnect();
    } else console.log(JSON.stringify(status, null, 2));
  } catch (error) {
    await cleanup(error);
  }
}
async function start(options) {
  let existing;
  try {
    existing = await control("status");
  } catch {}
  if (existing?.connected)
    throw new Error(
      "An agent is already connected. Use ./connect status or ./connect stop.",
    );
  await mkdir(local, { recursive: true, mode: 0o700 });
  const log = await open(join(local, "agent.log"), "a", 0o600);
  const args = [fileURLToPath(import.meta.url), "run"];
  for (const [key, value] of Object.entries(options))
    args.push(`--${key}`, String(value));
  const child = spawn(process.execPath, args, {
    cwd: root,
    detached: true,
    stdio: ["ignore", log.fd, log.fd, "ipc"],
  });
  await log.close();
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Connection timed out. See .local/agent.log."));
    }, 210000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Connection process exited. See .local/agent.log."));
    });
    child.on("message", (msg) => {
      if (!msg.ready && !msg.error) return;
      clearTimeout(timer);
      msg.error ? reject(new Error(msg.error)) : resolve(msg.ready);
    });
  });
  child.unref();
  console.log(JSON.stringify(status, null, 2));
}
export async function main(argv = process.argv.slice(2)) {
  const { command, options, values } = parseArgs(argv);
  if (command === "help") {
    console.log(`./connect [start] [--url https://devnet.load.game/] [--name Codex] [--radius 20] [--voice ember]
./connect status | stop
./connect move X Y Z
./connect say "Public chat message"
./connect text "Prompt the voice companion"
./connect run             Run in the foreground

Requires Node.js 22+ and Codex CLI logged in with Realtime access.
The default command returns after world, LiveKit, and Codex are connected.
Audio is sent to your Codex session only for audible players within the radius,
except speakers with the world's global voice mode. Ctrl+C stops foreground mode.`);
  } else if (command === "run") await run(options);
  else if (command === "start") await start(options);
  else if (command === "move") {
    if (values.length !== 3) throw new Error("Usage: ./connect move X Y Z");
    console.log(
      JSON.stringify(
        await control("move", { position: values.map(Number) }),
        null,
        2,
      ),
    );
  } else if (command === "say" || command === "text")
    console.log(
      JSON.stringify(await control(command, { text: values.join(" ") })),
    );
  else {
    console.log(JSON.stringify(await control(command), null, 2));
    if (command === "stop")
      for (let i = 0; i < 60; i++) {
        try {
          await readFile(lockFile);
          await delay(100);
        } catch {
          break;
        }
      }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
