import { FoxvoiceError } from "./errors.js";

/** Whisper and the transcription servers take 16 kHz mono audio. */
export const SAMPLE_RATE = 16000;

/** Decode recorded or loaded audio to 16 kHz mono. The browser resamples it. */
export async function decodeAudio(blob: Blob): Promise<Float32Array> {
  if (typeof OfflineAudioContext === "undefined") throw new FoxvoiceError("unsupported", "This page has no OfflineAudioContext, so it cannot decode audio. Pass 16 kHz samples as a Float32Array.");
  try {
    const decoded = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(await blob.arrayBuffer());
    if (decoded.numberOfChannels === 1) return decoded.getChannelData(0);
    const mono = new Float32Array(decoded.length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      const data = decoded.getChannelData(channel);
      for (let i = 0; i < mono.length; i++) mono[i] = (mono[i] ?? 0) + (data[i] ?? 0) / decoded.numberOfChannels;
    }
    return mono;
  } catch (error) {
    throw new FoxvoiceError("bad_audio", `The audio does not decode: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** The loudest 30 ms frame, as root mean square from 0 to 1. Speech is about 0.05 and up. */
export function loudness(audio: Float32Array): number {
  const frame = (SAMPLE_RATE * 30) / 1000;
  let loudest = 0;
  for (let start = 0; start < audio.length; start += frame) {
    const end = Math.min(start + frame, audio.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += (audio[i] ?? 0) ** 2;
    loudest = Math.max(loudest, Math.sqrt(sum / (end - start)));
  }
  return loudest;
}

/** 16-bit PCM WAV bytes, for servers that take a file. */
export function encodeWav(audio: Float32Array, sampleRate = SAMPLE_RATE): Blob {
  const view = new DataView(new ArrayBuffer(44 + audio.length * 2));
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + audio.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, audio.length * 2, true);
  for (let i = 0; i < audio.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, audio[i] ?? 0)) * 0x7fff, true);
  return new Blob([view.buffer], { type: "audio/wav" });
}
