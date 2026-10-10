// createVoice: push to talk, choose a speech to text provider, and speak the
// answer. Private mode is the default: only the browser and local tiers run.
import { decodeAudio } from "./audio.js";
import { FoxvoiceError, type ErrorCode } from "./errors.js";
import { openMic, type Mic, type MicOptions, type StopReason } from "./mic.js";
import { speak, type SpeakOptions, type Spoken } from "./speak.js";
import type { SttProvider, SttStatus, Tier, TranscribeOptions, Transcription } from "./types.js";

export interface VoiceOptions {
  /** Speech to text providers, tried in order. */
  stt: SttProvider[];
  /** The tiers that may run. Default ["browser", "local"]: audio and text stay on this computer. */
  only?: Tier[];
  /** Provider names or tiers to try first. It only changes the order. */
  prefer?: string[];
  /** Try the next provider when one fails during the call. Default false. */
  fallbackOnError?: boolean;
  mic?: Omit<MicOptions, "signal" | "onLevel">;
  /** Speech options. `localOnly` defaults to true unless `only` has "cloud". */
  tts?: Omit<SpeakOptions, "signal">;
}

export interface Skip {
  provider: string;
  code: ErrorCode | string;
  reason: string;
}

export interface Heard extends Transcription {
  provider: string;
  tier: Tier;
  model: string;
  /** How long the transcription took. */
  ms: number;
  /** How long the audio is. */
  audioMs: number;
  /** For listen(): why the microphone went off. */
  stoppedBy?: StopReason;
  skipped: Skip[];
}

export type VoiceState = "idle" | "listening" | "transcribing" | "speaking";

interface Events {
  state: VoiceState;
  level: number;
  transcript: Heard;
  error: FoxvoiceError;
}

export interface Voice {
  readonly state: VoiceState;
  /** Turn the microphone on. Resolves with the transcript after stop(), the time limit or the device ends. Stops any speech first. */
  listen(options?: { signal?: AbortSignal; maxMs?: number; language?: string }): Promise<Heard>;
  /** Let go of push to talk. */
  stop(): void;
  /** Drop the audio or stop the speech. The running call rejects with code aborted. */
  cancel(): void;
  /** Transcribe audio without the microphone: 16 kHz samples, or a Blob the browser can decode. */
  transcribe(audio: Float32Array | Blob, options?: TranscribeOptions): Promise<Heard>;
  speak(text: string, options?: Omit<SpeakOptions, "signal">): Promise<Spoken>;
  on<K extends keyof Events>(event: K, listener: (value: Events[K]) => void): () => void;
  status(): SttStatus[];
}

export function createVoice(options: VoiceOptions): Voice {
  const only = options.only ?? ["browser", "local"];
  const listeners = new Map<keyof Events, Set<(value: never) => void>>();
  const emit = <K extends keyof Events>(event: K, value: Events[K]) => {
    for (const listener of listeners.get(event) ?? []) (listener as (v: Events[K]) => void)(value);
  };
  let state: VoiceState = "idle";
  const setState = (next: VoiceState) => {
    if (next === state) return;
    state = next;
    emit("state", next);
  };
  let mic: Mic | undefined;
  // stop() can come before the microphone is open: the user let go at once.
  let letGo = false;
  let call: AbortController | undefined;

  const rank = (provider: SttProvider) => {
    const order = options.prefer ?? [];
    const at = order.findIndex((entry) => entry === provider.name || entry === provider.tier);
    return at === -1 ? order.length : at;
  };

  async function route(audio: Float32Array, limits: TranscribeOptions): Promise<Heard> {
    const skipped: Skip[] = [];
    const dropped: Skip[] = [];
    for (const provider of options.stt) {
      if (!only.includes(provider.tier)) dropped.push({ provider: provider.name, code: "private_mode", reason: `${provider.name} is tier "${provider.tier}", which "only" does not allow (private mode). Add it to "only" to opt in.` });
    }
    const allowed = options.stt.filter((provider) => only.includes(provider.tier)).map((provider, index) => ({ provider, index }));
    allowed.sort((a, b) => rank(a.provider) - rank(b.provider) || a.index - b.index);
    const result = await tryEach(allowed.map(({ provider }) => provider), audio, limits, skipped);
    skipped.push(...dropped);
    if (result) return result;
    throw new FoxvoiceError("no_provider", `No speech to text provider can run:\n${skipped.map((skip) => `- ${skip.provider}: ${skip.reason}`).join("\n") || "- the list is empty"}`);
  }

  async function tryEach(providers: SttProvider[], audio: Float32Array, limits: TranscribeOptions, skipped: Skip[]): Promise<Heard | undefined> {
    for (const provider of providers) {
      const probe = await provider.probe(limits);
      if (!probe.ok) {
        skipped.push({ provider: provider.name, code: probe.code ?? "unreachable", reason: probe.reason ?? "The probe failed." });
        continue;
      }
      const started = Date.now();
      try {
        const result = await provider.transcribe(audio, limits);
        if (!result.text.trim()) throw new FoxvoiceError("no_speech", `${provider.name} heard no words.`, { provider: provider.name, tier: provider.tier });
        return { ...result, provider: provider.name, tier: provider.tier, model: provider.model, ms: Date.now() - started, audioMs: Math.round(audio.length / 16), skipped };
      } catch (error) {
        const failed = error instanceof FoxvoiceError ? error : new FoxvoiceError("bad_response", String(error), { provider: provider.name, tier: provider.tier, cause: error });
        if (!options.fallbackOnError || failed.code === "aborted" || failed.code === "no_speech" || failed.code === "too_long") throw failed;
        skipped.push({ provider: provider.name, code: failed.code, reason: failed.message });
      }
    }
    return undefined;
  }

  /** Run one call: the state, the abort, and the error event. */
  async function guard<T>(busy: VoiceState, work: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
    call?.abort();
    const controller = new AbortController();
    call = controller;
    const signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
    setState(busy);
    try {
      return await work(signal);
    } catch (error) {
      if (error instanceof FoxvoiceError) emit("error", error);
      throw error;
    } finally {
      if (call === controller) {
        call = undefined;
        mic = undefined;
        setState("idle");
      }
    }
  }

  return {
    get state() {
      return state;
    },
    listen(listenOptions = {}) {
      if (state === "listening" || state === "transcribing") return Promise.reject(new FoxvoiceError("busy", "The microphone is already on. Call stop() or cancel() first."));
      return guard(
        "listening",
        async (signal) => {
          letGo = false;
          mic = await openMic({ ...options.mic, ...(listenOptions.maxMs ? { maxMs: listenOptions.maxMs } : {}), signal, onLevel: (level) => emit("level", level) });
          if (letGo) mic.stop();
          const recording = await mic.done;
          setState("transcribing");
          const heard = await route(recording.audio, { signal, ...(listenOptions.language ? { language: listenOptions.language } : {}) });
          const result = { ...heard, stoppedBy: recording.stoppedBy };
          emit("transcript", result);
          return result;
        },
        listenOptions.signal,
      );
    },
    stop() {
      letGo = true;
      mic?.stop();
    },
    cancel: () => call?.abort(),
    transcribe(audio, limits = {}) {
      return guard(
        "transcribing",
        async (signal) => {
          const samples = audio instanceof Float32Array ? audio : await decodeAudio(audio);
          const heard = await route(samples, { ...limits, signal });
          emit("transcript", heard);
          return heard;
        },
        limits.signal,
      );
    },
    speak(text, speakOptions = {}) {
      return guard("speaking", (signal) => speak(text, { localOnly: !only.includes("cloud"), ...options.tts, ...speakOptions, signal }));
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(listener as (value: never) => void);
      return () => set.delete(listener as (value: never) => void);
    },
    status: () => options.stt.map((provider) => provider.status()),
  };
}
