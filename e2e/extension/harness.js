// The E2E harness page. e2e/run.mjs calls window.fv.* here, in the
// extension, so foxvoice runs with the real Firefox media and speech APIs.
import { decodeAudio, openMic } from "../../src/index.ts";
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

window.fv = {
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
