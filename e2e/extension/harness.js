// The E2E harness page. e2e/run.mjs calls window.fv.* here, in the
// extension, so foxvoice runs with the real Firefox media and speech APIs.
import { useWavMic, wavMic } from "./wav-mic.js";

const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

/** Record a stream with MediaRecorder until it is stopped, and return the bytes. */
async function record(stream, until) {
  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));
  recorder.start();
  await until;
  recorder.stop();
  await stopped;
  for (const track of stream.getTracks()) track.stop();
  return new Blob(chunks);
}

window.fv = {
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
