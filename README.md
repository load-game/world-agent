# World agent

Connect a Codex companion to a LOAD world and talk to it through proximity voice.

Clone this repository, open it in Codex or Codex CLI, and ask:

> Connect to the world.

The repository's `AGENTS.md` tells Codex to run one command:

```sh
./connect
```

It installs dependencies on first use and connects to [devnet](https://devnet.load.game/).
The command returns the companion's position, city instance, and voice status.
Open the world, enable your microphone, and stand beside **Codex** at the spawn.
Ask a question normally. Its reply comes from its avatar through the game's
spatial voice system. Headphones help prevent your microphone feeding its voice
back into the conversation.

## Requirements

- Node.js 22 or newer, npm, and Bash.
- Codex CLI on PATH, authenticated with `codex login`, with access to Codex Realtime.
- Network access to the world, its LiveKit service, and Codex.

Verified on Linux x64 with Node 24 and Codex CLI 0.154.0. Native WebRTC packages
also distribute macOS builds, but this repository has not been tested on macOS.
On Windows, use WSL2. The desktop app alone does not guarantee a `codex` executable
on PATH. `CODEX_BIN` can point to another installed Codex executable.

No local microphone, browser, game build, wallet, LiveKit admin key, or separate
OpenAI API key is needed by this connector. Your human player uses the browser
microphone. Realtime is experimental and account availability can vary.

## Commands

```sh
./connect --name "My companion"
./connect --url https://another-world.example/
./connect --radius 12
./connect status
./connect text "Please introduce yourself briefly."
./connect move 2 0.24 18
./connect say "Hello from my agent."
./connect stop
```

`./connect` runs in the background and keeps working after the launching command
returns. `./connect run` stays in the foreground and stops on Ctrl+C. `npm start`
also starts the background connection. Run `./connect help` for all options.
Stop an existing connection before changing its URL, name, voice, or radius.
`WORLD_URL` overrides the default URL. `--voice` defaults to `ember`.

The HTTPS URL discovers `env.js` as data and uses the world's admission endpoint
when configured. You can also supply a full `wss://.../ws` URL for a direct world.
A pooled instance still requires a valid admission ticket; this client never
bypasses admission. Tokens supplied in a command argument can be visible in your
shell history and process list, so prefer the normal HTTPS join flow.

## What the companion can do

The voice session has tools to list players and positions, move its own avatar,
and send public text chat. Say "Who is nearby?" or "Come stand beside me."
Movement changes coordinates without physics, walking animation, collision, or
pathfinding. The agent does not render the scene or inspect objects and buildings.

The companion runs a separate Codex conversation from the task that launched it.
Its thread ID appears in status. It uses your existing Codex login, but does not
inherit the launching task's conversation. `./connect text` lets that task pass
along context or a request. Stopping and starting creates a fresh conversation
and guest player, rather than resuming someone else's world session.

Public devnet can contain multiple cities. Compare the status player list with
who you see in the browser. Joining the same hostname does not guarantee the same
city, especially when one city fills. This release does not implement the game's
friend-travel flow. It reports its assigned city rather than claiming to have
joined your specific city.

## Voice and local data

The companion receives microphone tracks only. It ignores its own voice,
unknown players, disabled speakers, and moderator-muted players. Spatial voices
use the engine's inverse distance attenuation and a hard listening radius of
20 meters by default, configurable up to 40 meters. World-designated global
speakers remain audible at any distance. Filtering happens before audio reaches
Codex. The browser applies its normal attenuation to the companion's reply.

Multiple nearby microphones are mixed into one stream. Speaker attribution and
concurrent overlapping conversations are not supported. Nearby people can talk
to the companion; there is no owner-only voice authentication. Its Codex session
disables shell, apps, plugins, hooks, and ambient MCP integrations and supplies
only the world tools above. Do not use it for privileged host or wallet actions.

A bearer-protected control server listens on a random loopback port. Its secret
and process lock live in `.local/` with private permissions. `status` includes
the last completed voice transcript in memory. Codex keeps the conversation
according to your local Codex settings. This connector does not record audio or
write transcripts to its log. `.local/agent.log` contains connection diagnostics.

Loss of the game, voice room, or Codex connection stops the companion. LiveKit
can recover short transport interruptions; a terminal disconnect requires
`./connect` again. There is no silent switch to a different world or voice room.

## Development

```sh
npm ci
npm run check
```

See [architecture and verification](docs/architecture.md) for protocol details,
live-test evidence, and remaining limits. This repository is independent of the
world checkout and requires no submodules. It does not deploy game changes.
