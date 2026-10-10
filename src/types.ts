import type { Probe, Tier } from "foxmind";

export type { Probe, Tier };

export interface TranscribeOptions {
  signal?: AbortSignal;
  /** The longest wait for one transcription, in milliseconds. */
  timeoutMs?: number;
  /** A language code such as "en" or "fr". Default: the model decides. */
  language?: string;
}

export interface Transcription {
  text: string;
  /**
   * From 0 to 1: how sure the model is of its words. Whisper in the browser
   * gives the mean probability of each word piece. A server gives it only
   * when it sends log probabilities; otherwise it is undefined.
   */
  confidence?: number;
}

export interface SttStatus {
  name: string;
  tier: Tier;
  model: string;
  state: "idle" | "loading" | "ready" | "unavailable" | "error";
  /** Where it runs: "wasm", "webgpu" or a server URL. */
  where?: string;
  /** Download progress from 0 to 1 while a model loads. */
  progress?: number;
  reason?: string;
}

/** One speech to text engine. foxvoice ships whisper() for the browser and transcriptionServer() for servers. */
export interface SttProvider {
  readonly name: string;
  readonly tier: Tier;
  readonly model: string;
  /** Check, without a model call, that the provider can run now. */
  probe(options?: TranscribeOptions): Promise<Probe>;
  status(): SttStatus;
  /** Download and start the model now, not at the first call. */
  load?(options?: TranscribeOptions): Promise<void>;
  /** Transcribe 16 kHz mono samples. */
  transcribe(audio: Float32Array, options: TranscribeOptions): Promise<Transcription>;
}
