import { audioClass } from "./authority.mjs";
import { EventEmitter } from "node:events";
import {
  Room,
  RoomEvent,
  AudioStream,
  AudioSource,
  AudioFrame,
  LocalAudioTrack,
  TrackSource,
  TrackPublishOptions,
} from "@livekit/rtc-node";
import { gainFor } from "./protocol.mjs";
export const RATE = 24000,
  SAMPLES = 480;
export function mix(frames) {
  const result = new Int16Array(SAMPLES);
  for (let i = 0; i < result.length; i++) {
    let value = 0;
    for (const { data, gain } of frames) value += (data[i] || 0) * gain;
    result[i] = Math.max(-32768, Math.min(32767, Math.round(value)));
  }
  return result;
}
export function pcmBytes(samples) {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((n, i) => bytes.writeInt16LE(n, i * 2));
  return bytes;
}
export function outputSamples(audio) {
  const bytes = Buffer.from(audio.data, "base64");
  const channels = audio.numChannels,
    rate = audio.sampleRate;
  if (
    ![1, 2].includes(channels) ||
    !Number.isInteger(rate) ||
    rate < 8000 ||
    rate > 96000 ||
    bytes.length % (2 * channels)
  )
    throw new Error("Unsupported Codex audio format");
  const count = bytes.length / (2 * channels);
  if (!count || count > rate * 10)
    throw new Error("Invalid Codex audio chunk size");
  const mono = new Float64Array(count);
  for (let i = 0; i < count; i++)
    for (let c = 0; c < channels; c++)
      mono[i] += bytes.readInt16LE((i * channels + c) * 2) / channels;
  const samples = new Int16Array(Math.round((count * RATE) / rate));
  for (let i = 0; i < samples.length; i++) {
    const x = (i * rate) / RATE,
      a = Math.floor(x),
      b = Math.min(a + 1, count - 1);
    samples[i] = Math.round(mono[a] + (mono[b] - mono[a]) * (x - a));
  }
  return samples;
}
export class Voice extends EventEmitter {
  constructor(world, codex) {
    super();
    this.world = world;
    this.codex = codex;
    this.room = new Room();
    this.inputs = new Map();
    this.output = [];
    this.outputSize = 0;
    this.generation = 0;
    this.silentTicks = 0;
    this.stats = {
      inputSamples: 0,
      outputSamples: 0,
      outputSpeechSamples: 0,
      droppedInputFrames: 0,
      interruptions: 0,
    };
    this.onAudio = ({ audio, channel = "guest" }) => {
      try {
        const samples = outputSamples(audio);
        const energy =
          samples.reduce((sum, n) => sum + Math.abs(n), 0) / samples.length;
        const now = Date.now();
        if (
          energy > 25 &&
          (channel !== "guest" || !this.activeChannel || now > this.activeUntil)
        ) {
          if (this.activeChannel !== channel) this.clearOutput();
          this.activeChannel = channel;
        }
        if (this.activeChannel !== channel) return;
        if (energy > 25) this.activeUntil = now + 600;
        if (now <= this.activeUntil) this.enqueue(audio);
      } catch (error) {
        this.emit("failure", error);
      }
    };
    this.onInterrupt = ({ channel } = {}) => {
      if (channel && this.activeChannel && channel !== this.activeChannel)
        return;
      this.clearOutput();
      this.stats.interruptions++;
    };
    this.onPairing = () => {
      this.inputs.forEach((input) => {
        input.frames = [];
      });
      this.clearOutput();
    };
    this.onWorld = () => {
      if (!this.canSpeak()) this.clearOutput();
    };
  }
  canSpeak() {
    return (
      this.world.connected &&
      !this.world.muted.has(this.world.id) &&
      (this.world.levels[this.world.id] || this.world.voiceLevel) !== "disabled"
    );
  }
  async start() {
    const opts = this.world.livekit;
    if (!opts?.token || !opts?.wsUrl)
      throw new Error("This world has no voice service enabled.");
    this.source = new AudioSource(RATE, 1, 200);
    this.track = LocalAudioTrack.createAudioTrack("Codex voice", this.source);
    this.room.on(
      RoomEvent.TrackSubscribed,
      (track, publication, participant) => {
        if (publication.source !== TrackSource.SOURCE_MICROPHONE) return;
        void this.consume(track, participant.identity).catch((error) => {
          if (!this.closing) this.emit("failure", error);
        });
      },
    );
    this.room.on(RoomEvent.Disconnected, () => {
      if (!this.closing)
        this.emit("failure", new Error("Voice room disconnected"));
    });
    this.room.on(RoomEvent.Reconnecting, () => {
      this.clearOutput();
      this.inputs.forEach((input) => {
        input.frames = [];
      });
    });
    await this.room.connect(opts.wsUrl, opts.token, {
      autoSubscribe: true,
      dynacast: true,
    });
    const publish = new TrackPublishOptions();
    publish.source = TrackSource.SOURCE_MICROPHONE;
    await this.room.localParticipant.publishTrack(this.track, publish);
    this.codex.on("thread/realtime/outputAudio/delta", this.onAudio);
    this.world.on("update", this.onWorld);
    this.world.on("pairing", this.onPairing);
    this.codex.on("interrupted", this.onInterrupt);
    this.timer = setInterval(() => this.tick(), 20);
    this.connected = true;
  }
  async consume(track, identity) {
    const reader = new AudioStream(track, {
      sampleRate: RATE,
      numChannels: 1,
      frameSizeMs: 20,
    }).getReader();
    const input = { reader, frames: [], track };
    this.inputs.set(track.sid, input);
    input.identity = identity;
    try {
      while (!this.closing) {
        const { done, value } = await reader.read();
        if (done) break;
        if (
          track.muted ||
          gainFor(this.world, identity, this.world.radius) === 0
        ) {
          input.frames = [];
          continue;
        }
        input.frames.push(new Int16Array(value.data));
        if (input.frames.length > 5) {
          input.frames.shift();
          this.stats.droppedInputFrames++;
        }
      }
    } finally {
      this.inputs.delete(track.sid);
      reader.releaseLock();
    }
  }
  tick() {
    if (this.closing || !this.codex.ready || !this.world.connected) return;
    const frames = [],
      ownerFrames = [],
      guestFrames = [];
    for (const input of this.inputs.values()) {
      const gain = input.track.muted
        ? 0
        : gainFor(this.world, input.identity, this.world.radius);
      if (!gain) {
        input.frames = [];
        continue;
      }
      const data = input.frames.shift();
      if (data) {
        const frame = { data, gain };
        frames.push(frame);
        (audioClass(input.identity, this.world.companion) === "owner"
          ? ownerFrames
          : guestFrames
        ).push(frame);
      }
    }
    const samples = mix(frames);
    const energy = Math.sqrt(
      samples.reduce((sum, n) => sum + n * n, 0) / samples.length,
    );
    // Clear buffered speech on a new audible utterance, including native playout.
    if (energy > 450) {
      if (
        !this.speaking &&
        (this.outputSize || this.source.queuedDuration > 0)
      ) {
        this.blockedItem = this.currentItem;
        this.clearOutput();
        this.stats.interruptions++;
      }
      this.speaking = true;
      this.silentTicks = 0;
    } else if (++this.silentTicks > 15) this.speaking = false;
    if ((this.inFlight || 0) >= 5) {
      this.stats.droppedInputFrames++;
      return;
    }
    this.inFlight = (this.inFlight || 0) + 1;
    if (frames.length) this.stats.inputSamples += SAMPLES;
    void (
      this.codex.appendAudioGroups
        ? this.codex.appendAudioGroups({
            owner: pcmBytes(mix(ownerFrames)),
            guest: pcmBytes(mix(guestFrames)),
          })
        : this.codex.appendAudio(pcmBytes(samples))
    )
      .catch((error) => {
        if (!this.closing) this.emit("failure", error);
      })
      .finally(() => this.inFlight--);
  }
  enqueue(audio) {
    if (this.closing || !this.canSpeak()) return;
    if (audio.itemId && audio.itemId === this.blockedItem) return;
    this.currentItem = audio.itemId;
    const samples = outputSamples(audio);
    if (this.outputSize + samples.length > RATE * 15)
      throw new Error("Codex audio exceeded the bounded playback queue");
    this.output.push(samples);
    this.outputSize += samples.length;
    void this.play().catch((error) => {
      if (!this.closing) this.emit("failure", error);
    });
  }
  async play() {
    if (this.playing) return;
    this.playing = true;
    try {
      while (this.output.length && !this.closing) {
        const samples = this.output.shift();
        this.outputSize -= samples.length;
        const generation = this.generation;
        for (let i = 0; i < samples.length; i += SAMPLES) {
          if (
            this.closing ||
            generation !== this.generation ||
            !this.canSpeak()
          )
            break;
          const chunk = samples.subarray(i, i + SAMPLES);
          await this.source.captureFrame(
            new AudioFrame(chunk, RATE, 1, chunk.length),
          );
          this.stats.outputSamples += chunk.length;
          this.stats.outputSpeechSamples += chunk.filter(
            (n) => Math.abs(n) > 100,
          ).length;
        }
      }
    } finally {
      this.playing = false;
    }
  }
  clearOutput() {
    this.generation++;
    this.output = [];
    this.outputSize = 0;
    this.source?.clearQueue();
  }
  async close() {
    this.closing = true;
    this.connected = false;
    clearInterval(this.timer);
    this.clearOutput();
    this.codex.off("interrupted", this.onInterrupt);
    this.codex.off("thread/realtime/outputAudio/delta", this.onAudio);
    this.world.off("update", this.onWorld);
    this.world.off("pairing", this.onPairing);
    await Promise.allSettled(
      [...this.inputs.values()].map((i) => i.reader.cancel()),
    );
    await this.room.disconnect();
    await this.track?.close();
    await this.source?.close();
  }
}
