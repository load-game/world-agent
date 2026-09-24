import wrtc from "@roamhq/wrtc";
import { EventEmitter } from "node:events";
import { pcmBytes } from "./audio.mjs";

// The same WebRTC transport used by Schedule, with virtual audio devices.
export class RealtimeMedia extends EventEmitter {
  constructor() {
    super();
    this.pc = new wrtc.RTCPeerConnection();
    this.source = new wrtc.nonstandard.RTCAudioSource();
    this.track = this.source.createTrack();
    this.pc.addTrack(this.track);
    this.channel = this.pc.createDataChannel("oai-events");
    this.channel.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "input_audio_buffer.speech_started")
        this.emit("interrupted");
    };
    this.pc.ontrack = ({ track }) => {
      if (track.kind !== "audio") return;
      this.sink = new wrtc.nonstandard.RTCAudioSink(track);
      this.sink.ondata = (data) =>
        this.emit("audio", {
          data: pcmBytes(data.samples).toString("base64"),
          sampleRate: data.sampleRate,
          numChannels: data.channelCount,
          itemId: null,
        });
    };
    this.pc.onconnectionstatechange = () => {
      if (
        ["failed", "closed"].includes(this.pc.connectionState) &&
        !this.closing
      )
        this.emit("failure", new Error("Codex WebRTC disconnected"));
    };
  }
  async offer() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    return this.pc.localDescription.sdp;
  }
  async answer(sdp) {
    await this.pc.setRemoteDescription({ type: "answer", sdp });
    await new Promise((resolve, reject) => {
      if (this.channel.readyState === "open") return resolve();
      const timer = setTimeout(
        () => reject(new Error("Codex WebRTC audio connection timed out")),
        30000,
      );
      this.channel.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.channel.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Codex WebRTC data channel failed"));
      };
    });
  }
  input(bytes) {
    if (this.closing) return;
    // Codex receives 48 kHz PCM via WebRTC. The mixer runs at 24 kHz.
    for (let offset = 0; offset < bytes.length; offset += 480) {
      const samples = new Int16Array(480);
      for (let i = 0; i < 240; i++)
        samples[2 * i] = samples[2 * i + 1] = bytes.readInt16LE(offset + i * 2);
      this.source.onData({
        samples,
        sampleRate: 48000,
        bitsPerSample: 16,
        channelCount: 1,
        numberOfFrames: 480,
      });
    }
  }
  close() {
    this.closing = true;
    this.sink?.stop();
    this.track.stop();
    this.channel.close();
    this.pc.close();
  }
}
