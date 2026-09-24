# Architecture and verification

`connect` installs the lockfile dependencies and launches `src/cli.mjs`. The CLI
starts a detached process with a private local control endpoint. Readiness means
all three connections succeeded: world snapshot, Codex WebRTC data channel, and
LiveKit microphone publication. Startup failure closes the other connections.

`world.mjs` implements the player wire protocol needed for presence, player
positions, text chat, and voice settings. It does not download or execute world
scripts. `protocol.mjs` follows the MessagePack packet IDs in
[load-game/gamedev](https://github.com/load-game/gamedev/blob/baa675e81aa1df4727ce15b806d6fd79aa4cd2b6/packages/core/packets.js).
Protocol changes upstream need compatibility checks here. The current engine
has no version negotiation for these packets.

`codex.mjs` launches a restricted Codex app-server and bootstraps its world tools
before starting Realtime v3. This follows the working Schedule prototype's
operator/WebRTC design. The experimental protocol was checked against
`codex app-server generate-ts --experimental` from CLI 0.154.0.
The [official app-server documentation](https://learn.chatgpt.com/docs/app-server)
describes the underlying session and tool integration. The installed experimental
schema is the source for the realtime-specific request fields.

`realtime-media.mjs` uses a virtual WebRTC microphone and speaker. Direct Codex
WebSocket audio was rejected with "realtime conversation requires API key auth"
under the tested login, while the Schedule-style WebRTC flow worked. The connector
therefore uses WebRTC without changing the user's account configuration.

`audio.mjs` receives LiveKit microphone PCM through the
[LiveKit Node RTC SDK](https://docs.livekit.io/reference/client-sdk-node/), applies
current player positions and moderation, and mixes bounded 20 ms frames at
24 kHz. A virtual WebRTC microphone sends these to Codex at 48 kHz. Codex's remote
audio is downmixed/resampled and published as the player's LiveKit microphone.
Input queues hold at most five frames per track. Playback has a 15-second upper
bound and a 200 ms native queue. Barge-in clears queued audio. Audio does not go
to the host's speakers or microphone.

The headless player consumes the same server-provided voice credentials and
player identity as a browser. No LiveKit API secret is present. Native audio
libraries need platform binaries, which is why the lockfile and a tested host
platform are part of the release.

## Verification, September 24, 2026

- Automated tests cover wire encoding including Sets, admission, proximity and
  global voice, mutes, coordinates, PCM conversion, mixing/clipping, tool
  rejection, request cleanup, and CLI validation.
- The single command joined public devnet and reported all three connections.
- A second headless player joined the same city, published synthetic speech,
  and received the companion's spoken response through LiveKit. Codex's completed
  transcript was "Purple pineapple.", matching the spoken test request.
- The receiving peer measured more than 1 MB of PCM including silence, with
  peak amplitude 13,666 and 13,569 samples above magnitude 100.
- A spoken player-list request delegated to Codex's world_status tool and named
  the actual participants. A typed movement request used world_move, updated
  the avatar to [2, 0.24, 18], and produced a matching spoken reply.
- Moving the publishing test peer 100 meters away left inputSamples unchanged
  at 984,000. The peer received only codec silence, peak amplitude 4, with no
  samples above magnitude 100 and no new reply transcript.
- Duplicate start was rejected while the original companion stayed connected.
- A real Chromium game client joined alongside the companion and subscribed to
  its microphone. The game's voice gain channel measured peak 0.01846 and
  maximum RMS 0.00416 from the companion. The browser also saw its new position.
  An initial browser ICE connection failed; retrying established voice. The
  browser reported software-renderer warnings, so this was an audio/connection
  check rather than a visual performance benchmark.
- Stop terminated the connector and removed its local control files. An unreachable local
  WebSocket endpoint failed startup without leaving a connection lock.
- A fresh Git clone ran `./connect` with no node_modules or local state. It
  installed its dependencies, joined devnet, reported world/voice/realtime
  ready, then stopped successfully. The clone remained Git-clean.
- Workspace coordination check passed. No game components or deployment changed.

Physical microphone, phone, macOS, long sessions, overlapping speakers, and
restrictive-network relay behavior have not been verified by this repository.
The existing shared voice service's TURN support remains server-owned.
