// The E2E harness page. e2e/run.mjs calls window.fv.* here, in the
// extension, so foxvoice runs with the real Firefox media and speech APIs.
import { whisper } from "../../src/browser/index.ts";
import { createVoice, decodeAudio, openMic, speak, transcriptionServer } from "../../src/index.ts";
import { said, spyOnSpeech } from "./spy.js";
import { useWavMic, wavMic } from "./wav-mic.js";

const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

/** Record a stream with MediaRecorder until it is stopped, and return the bytes. */
async function record(stream, until) {
  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.addEventListener("dataavailable", (event) => chunks.push(event.data));
  const stopped = new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }));
  recorder.start();
  await until;
  recorder.stop();
  await stopped;
  for (const track of stream.getTracks()) track.stop();
  return new Blob(chunks);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const trackState = () => wavMic.tracks.at(-1)?.readyState;
/** Run a promise and return its FoxvoiceError code, or "ok". */
const outcome = (promise) => promise.then(() => "ok", (error) => error.code ?? String(error));

let hub = "https://huggingface.co/";
const jfk = async () => decodeAudio(await (await fetch("jfk.wav")).blob());
/** Transcribe and time it; a failure gives its code. */
async function heard(provider, audio) {
  const started = performance.now();
  try {
    const result = await provider.transcribe(audio, {});
    return { ...result, ms: Math.round(performance.now() - started), status: provider.status() };
  } catch (error) {
    return { code: error.code ?? String(error), message: error.message, status: provider.status() };
  }
}

spyOnSpeech();

window.fv = {
  /**
   * createVoice on the WAV microphone. A cloud server (the test's trap) is
   * first in the list; private mode must never call it. With "barge-in",
   * a long reply is speaking when listen() starts.
   */
  async voice(trapUrl, how) {
    useWavMic("jfk.wav");
    const voice = createVoice({ stt: [transcriptionServer({ baseURL: trapUrl, tier: "cloud" }), whisper({ remoteHost: hub })] });
    const states = [];
    voice.on("state", (state) => states.push(state));
    let speech;
    if (how === "barge-in") {
      speech = voice.speak("This is a long reply that keeps going while the user starts to speak again.").catch((error) => error.code);
      await wait(800);
    }
    const calls = wavMic.calls;
    const listening = voice.listen();
    while (wavMic.calls === calls) await wait(20);
    await wavMic.ended;
    voice.stop();
    const result = await listening;
    return { ...result, states, speech: await speech, frames: document.querySelectorAll("iframe").length, track: trackState() };
  },
  /** speak() with the real engine; "cancel" aborts it after 300 ms. */
  async speak(text, how) {
    const controller = new AbortController();
    if (how === "cancel") setTimeout(() => controller.abort(), 300);
    const started = performance.now();
    const result = await speak(text, { signal: controller.signal }).catch((error) => ({ code: error.code, message: error.message }));
    return { ...result, ms: Math.round(performance.now() - started), said: said.slice(), frames: document.querySelectorAll("iframe").length, voices: speechSynthesis.getVoices().length };
  },
  /** Load models from the test's local hub. */
  useHub(url) {
    hub = url;
  },
  /** Whisper in this page, in the case the check asks for. */
  async whisper(kind) {
    const provider = whisper({ remoteHost: hub, ...(kind === "webgpu" ? { device: "webgpu" } : {}), ...(kind === "missing" ? { model: "onnx-community/no-such-whisper.en" } : {}) });
    if (kind === "twice") {
      const [one, two] = await Promise.all([heard(provider, await jfk()), heard(provider, await jfk())]);
      return { one, two, warm: await heard(provider, await jfk()) };
    }
    if (kind === "noise") {
      const noise = Float32Array.from({ length: 3 * 16000 }, () => (Math.random() * 2 - 1) * 0.05);
      return heard(provider, noise);
    }
    if (kind === "long") {
      const audio = await jfk();
      const long = new Float32Array(audio.length * 3);
      for (let i = 0; i < 3; i++) long.set(audio, i * audio.length);
      return heard(provider, long);
    }
    if (kind === "webgpu") return { ...(await heard(provider, await jfk())), hasGpu: Boolean(await navigator.gpu?.requestAdapter()) };
    if (kind === "cut") window.cutProvider = provider;
    return heard(kind === "cut-again" ? window.cutProvider : provider, await jfk());
  },
  /** openMic on the WAV microphone, stopped the way the check asks. */
  async mic(how) {
    useWavMic("jfk.wav");
    const levels = [];
    const mic = await openMic({ maxMs: how === "limit" ? 3000 : 30000, onLevel: (level) => levels.push(level) });
    if (how === "stop") {
      await wavMic.ended;
      mic.stop();
    }
    if (how === "cancel") {
      await wait(1000);
      mic.cancel();
      return { outcome: await outcome(mic.done), track: trackState() };
    }
    const recording = await mic.done;
    return { seconds: recording.ms / 1000, stoppedBy: recording.stoppedBy, samples: recording.audio.length, level: recording.level, levels: levels.length, track: trackState() };
  },
  /** The real decoder with bytes that are not audio. */
  async badAudio() {
    return outcome(decodeAudio(new Blob(["not audio"])));
  },

  /** The harness facts the later checks build on. */
  async env() {
    return { crossOriginIsolated: globalThis.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer, mediaRecorder: typeof MediaRecorder };
  },
  /** Firefox's fake device: a real getUserMedia call with the fake-media prefs. */
  async fakeDevice() {
    const stream = await realGetUserMedia({ audio: true });
    const blob = await record(stream, new Promise((resolve) => setTimeout(resolve, 500)));
    return { label: stream.getAudioTracks()[0]?.label, bytes: blob.size, ended: stream.getAudioTracks()[0]?.readyState };
  },
  /** The WAV microphone: record the whole file and decode it at 16 kHz. */
  async wavMic() {
    useWavMic("jfk.wav");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const blob = await record(stream, wavMic.ended);
    const audio = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(await blob.arrayBuffer());
    return { calls: wavMic.calls, bytes: blob.size, seconds: audio.duration, rate: audio.sampleRate, ended: wavMic.tracks[0]?.readyState };
  },
};
