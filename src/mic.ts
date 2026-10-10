import { SAMPLE_RATE, decodeAudio, loudness } from "./audio.js";
import { FoxvoiceError } from "./errors.js";

/** Replace the browser media APIs, for tests or for another audio source. */
export interface MediaHooks {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  MediaRecorder?: typeof MediaRecorder;
  /** Decode the recorded bytes to 16 kHz mono. Default: decodeAudio. */
  decode?: (blob: Blob) => Promise<Float32Array>;
}

export interface MicOptions {
  /** Stop by itself after this many milliseconds. Default 30000, the Whisper window. */
  maxMs?: number;
  /** Shorter audio fails with too_short. Default 300. */
  minMs?: number;
  /** Audio whose loudest 30 ms is under this level fails with no_speech. Default 0.01. */
  minLevel?: number;
  signal?: AbortSignal;
  /** Audio track constraints. Default: mono with echo cancellation and noise suppression. */
  constraints?: MediaTrackConstraints;
  /** Called about 10 times a second with the input level from 0 to 1. */
  onLevel?: (level: number) => void;
  media?: MediaHooks;
}

/** Why the microphone went off: the user let go, the time limit, or the device ended. */
export type StopReason = "user" | "limit" | "device";

export interface Recording {
  /** 16 kHz mono samples. */
  audio: Float32Array;
  sampleRate: typeof SAMPLE_RATE;
  ms: number;
  stoppedBy: StopReason;
  /** The loudest 30 ms of the audio, from 0 to 1. */
  level: number;
}

export interface Mic {
  /** Let go: stop the microphone and transcribe what came. */
  stop(): void;
  /** Stop the microphone and drop the audio. `done` rejects with code aborted. */
  cancel(): void;
  readonly done: Promise<Recording>;
}

const aborted = () => new FoxvoiceError("aborted", "The microphone was cancelled.");

function micError(error: unknown): FoxvoiceError {
  const name = error instanceof Error ? error.name : "";
  const said = error instanceof Error ? error.message : String(error);
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new FoxvoiceError("mic_denied", `The microphone is not allowed (${said}). Click the microphone icon in the address bar, or open the extension's setup page, and allow it.`, { cause: error });
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return new FoxvoiceError("no_microphone", `No microphone was found (${said}).`, { cause: error });
  if (name === "NotReadableError" || name === "AbortError") return new FoxvoiceError("mic_busy", `The microphone cannot start: another app may hold it (${said}).`, { cause: error });
  return new FoxvoiceError("unsupported", `getUserMedia failed: ${said}`, { cause: error });
}

/** Turn the microphone on. It stays on until stop(), cancel(), the signal, the time limit or the device ends. */
export async function openMic(options: MicOptions = {}): Promise<Mic> {
  const { maxMs = 30000, minMs = 300, minLevel = 0.01, signal, onLevel, media = {} } = options;
  const devices = globalThis.navigator?.mediaDevices;
  const getUserMedia = media.getUserMedia ?? devices?.getUserMedia?.bind(devices);
  const Recorder = media.MediaRecorder ?? globalThis.MediaRecorder;
  const decode = media.decode ?? decodeAudio;
  if (signal?.aborted) throw aborted();
  if (!getUserMedia || !Recorder) throw new FoxvoiceError("unsupported", "This page has no getUserMedia or MediaRecorder. Use foxvoice in an extension page, such as a sidebar or popup, not a background page.");

  let stream: MediaStream;
  try {
    stream = await getUserMedia({ audio: options.constraints ?? { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (error) {
    throw micError(error);
  }
  const tracks = stream.getTracks();
  const off = () => {
    for (const track of tracks) track.stop();
  };
  let recorder: MediaRecorder;
  try {
    recorder = new Recorder(stream);
  } catch (error) {
    off();
    throw new FoxvoiceError("unsupported", `MediaRecorder cannot record this stream: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  const recorded = new Promise<void>((resolve) => recorder.addEventListener("stop", () => resolve(), { once: true }));
  const meter = onLevel ? startMeter(stream, onLevel) : undefined;

  let finish!: (reason: StopReason | "cancel") => void;
  const done = new Promise<Recording>((resolve, reject) => {
    let finished = false;
    finish = (reason) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (recorder.state !== "inactive") recorder.stop();
      off();
      meter?.();
      if (reason === "cancel") return reject(aborted());
      recorded.then(() => toRecording(chunks, reason)).then(resolve, reject);
    };
  });

  async function toRecording(parts: Blob[], stoppedBy: StopReason): Promise<Recording> {
    const blob = new Blob(parts, { type: recorder.mimeType });
    if (blob.size === 0) throw new FoxvoiceError("too_short", "No audio came from the microphone. Hold the button while you speak.");
    const audio = await decode(blob).catch((error: unknown) => {
      throw error instanceof FoxvoiceError ? error : new FoxvoiceError("bad_audio", `The audio does not decode: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    });
    const ms = Math.round((audio.length * 1000) / SAMPLE_RATE);
    if (ms < minMs) throw new FoxvoiceError("too_short", `The audio is ${ms} ms long, under the ${minMs} ms minimum. Hold the button while you speak.`);
    const level = loudness(audio);
    if (level < minLevel) throw new FoxvoiceError("no_speech", `The audio is silent (loudest level ${level.toFixed(4)}, under ${minLevel}). Check the microphone and speak again.`);
    return { audio, sampleRate: SAMPLE_RATE, ms, stoppedBy, level };
  }

  const onAbort = () => finish("cancel");
  signal?.addEventListener("abort", onAbort, { once: true });
  for (const track of tracks) track.addEventListener("ended", () => finish("device"), { once: true });
  const timer = setTimeout(() => finish("limit"), maxMs);
  recorder.start();
  return { stop: () => finish("user"), cancel: () => finish("cancel"), done };
}

/** Read the input level with an AnalyserNode. Returns the function that stops it. */
function startMeter(stream: MediaStream, onLevel: (level: number) => void): (() => void) | undefined {
  if (typeof AudioContext === "undefined") return undefined;
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    onLevel(loudness(samples));
  }, 100);
  return () => {
    clearInterval(timer);
    void context.close();
  };
}
