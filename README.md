# World agent

Connect a Codex companion to a LOAD world and talk to it through proximity voice.

Clone this repository:

```sh
git clone https://github.com/load-game/world-agent.git
cd world-agent
```

Open it in Codex or Codex CLI, and ask:

> Connect to the world.

The repository's `AGENTS.md` tells Codex to run one command:

```sh
./connect
```

It installs dependencies and Chromium on first use and connects to [devnet](https://devnet.load.game/).
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

The connector launches a headless Chromium game client. Linux needs Chromium's
system libraries; if startup reports missing libraries, install them with
`npx playwright install-deps chromium`. No local microphone, game build, wallet
private key, LiveKit admin key, or separate OpenAI API key is needed. Your human player uses the browser
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

The connector uses the normal HTTPS game entry point, including pooled admission.
Direct WebSocket URLs are not supported by the rendered companion. The world
must advertise companion protocol version 1; older worlds fail with an upgrade
message before granting any owner authority.

## Walking, perception, and ownership

The companion runs the actual game client. It walks with player physics and
animation, follows a player, faces a point, stops, and uses nearby interactions.
Its local path planner checks collision and ground within 35 meters. It reports
blocked or unreachable destinations and never falls back to teleporting.

It can inspect visible players, named city landmarks, and nearby interactions,
or take a screenshot through its game camera. Observations are current and
limited by distance and line of sight. It does not know everything in the city.

Start with your public wallet address to enable owner commands:

```sh
./connect --owner 0xYOUR_WALLET_ADDRESS
```

In the game, open **City → Companions**, connect that wallet, and pair your
companion. Sign the displayed message. No transaction is sent. This authorizes
your current player connection to give spoken movement and interaction commands.
An address or player name alone never authorizes anyone. This release supports
ordinary EVM signing wallets; contract-wallet signature verification is not
implemented.

Other players can talk to the companion but cannot control its actions. Without
`--owner`, everyone gets chat only. `./connect text` and the other local commands
remain available to the person running the repository. Unpairing or leaving the
city immediately stops the avatar and invalidates the old owner's tools. Pair
again after reconnecting. The companion holds no wallet key and cannot sign
transactions for you.

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

The verified owner's microphone goes to a separate Codex conversation from guest
microphones. Guests are mixed only with other guests. Each conversation has its
own tool permissions and history, and action tools recheck the pairing generation
when they execute. This identifies the authenticated player connection, not a
biometric voiceprint. Anyone able to send audio through that connection speaks
with its authority.

The companion speaks through one avatar. Owner replies take priority when guest
speech overlaps. This is not simultaneous independent voice calls. Pairing starts
an additional Realtime session; local typed requests start another isolated
session. All sessions disable shell, apps, plugins, hooks, and ambient MCP tools.

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
# Optional, joins a disposable companion-enabled city and walks:
WORLD_TEST_URL=https://your-test-world.example/ npm run test:world
```

See [architecture and verification](docs/architecture.md) for protocol details,
live-test evidence, and remaining limits. This repository is independent of the
world checkout and requires no submodules. It does not deploy game changes.
