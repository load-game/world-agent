# Architecture and verification

`connect` installs the lockfile dependencies and launches `src/cli.mjs`. The CLI
starts a detached process with a private local control endpoint. Readiness means
all three connections succeeded: world snapshot, Codex WebRTC data channel, and
LiveKit microphone publication. Startup failure closes the other connections.

`browser-world.mjs` launches Chromium and loads the game's normal entry point.
It uses the engine's physics, network replication, scene and camera. Headless
mode ticks simulation at 60 Hz and renders on demand, so software rendering does
not slow walking to the screenshot frame rate. Readiness waits for loaded app
scripts and a grounded player. `world.mjs` retains wire utilities used by test
peers and shared status logic; the connector does not use its coordinate setter.

The server advertises companion protocol 1. Wallet pairing is verified by the
server and binds the current owner player connection to this agent connection.
`authority.mjs` requires both that player ID and the current pairing generation.
Actions repeat the check in the browser immediately before execution. The
engine also cancels movement and held interactions on pairing changes.

`conversations.mjs` keeps guest, owner and local operator histories separate.
Only guest audio reaches the guest model, whose dynamic tool list is read-only.
Only audio from the signed owner player reaches the owner model. Re-pairing
creates a fresh owner conversation. Closing an old session cannot restore its
authority or publish late output. Guest interruptions cannot cut off an owner
reply. One LiveKit output track arbitrates replies with owner priority.

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

## Companion upgrade verification, September 24, 2026

- Engine component checks passed 257 tests with two environment-dependent skips;
  CI passed with PostgreSQL. World checks passed 199 tests with one skip, plus
  165 contract tests. The connector passed 22 tests.
- The one-command connector joined the private test world with renderer, LiveKit
  and guest Codex Realtime ready. An owner pairing started a separate Realtime
  session. Owner departure removed it while guest conversation stayed connected.
- Synthetic guest speech asked it to walk and say "Purple pineapple." It refused
  movement and answered the phrase. Its position remained at the spawn.
- A signed owner's synthetic spoken command walked the avatar from x=0 to x=4.92
  for a target of x=5, with y=0.26 and z=18. The receiver measured peak audio
  amplitude 18,162 and 47,229 samples above magnitude 100.
- Browser navigation reached three destinations with continuous sampled positions,
  including a route around plaza furniture. Observation returned visible named
  landmarks, and a camera screenshot showed the destination scene.
- Real pointer clicks opened City → Companions, paired using an injected test
  wallet's signature, and unpaired. No transaction was sent. A revoked owner
  action failed in the browser. This is not a physical wallet-extension test.


Unit tests exercise signature expiry, replay rejection, disconnect during
verification, session generation changes, forged guest actions, stale owner
output, separated input audio, pairing during startup, and interruption priority.
Engine tests cover route search and cancellation of pending interactions.
Browser proof includes continuous movement, scene observation, signed pairing,
revocation and rejection of the revoked owner's subsequent movement command.

Navigation is local and walk-only. Raised ledges that require jumping and other
unreachable destinations are reported, not bypassed. This is not a global
navigation mesh. Perception descriptions come from world scripts; screenshot
requests render the actual camera.

## Original connector verification, September 24, 2026

The following records the earlier socket-only release, before physics, camera
perception and owner pairing were added.


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
