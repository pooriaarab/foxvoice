// Test hooks for the demo panel; only the E2E build adds this script to
// panel.html, before panel.js. The microphone plays jfk.wav, model files come
// from the test's local hub (panel.html?hub=<url>), and speech is recorded.
import { said, spyOnSpeech } from "./spy.js";
import { useWavMic, wavMic } from "./wav-mic.js";

const hub = new URL(location.href).searchParams.get("hub");
if (hub) {
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => realFetch(typeof input === "string" && input.startsWith("https://huggingface.co/") ? input.replace("https://huggingface.co/", hub) : input, init);
}
useWavMic("jfk.wav");
spyOnSpeech();
window.e2e = { said, wavMic };
