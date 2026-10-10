// The push-to-talk sidebar: hold the button, foxvoice transcribes on this
// computer, a local model answers through foxmind, and the reply is spoken.
import { createMind, openaiCompatible } from "foxmind";
import { whisper } from "../src/browser/index.ts";
import { createVoice, whisperServer } from "../src/index.ts";

const $ = (id) => document.getElementById(id);
const talk = $("talk");
const fields = { engine: $("engine"), server: $("server"), model: $("model"), speak: $("speak") };
const engines = { whisper: whisper(), "whisper-server": whisperServer() };
let voice;
let progressTimer;

function show(id, text, meta = "") {
  $(id).textContent = text;
  $(id).classList.toggle("empty", !text);
  $(`${id}-meta`).textContent = meta;
}

function makeVoice() {
  voice = createVoice({ stt: [engines[fields.engine.value]] });
  voice.on("level", (level) => ($("level").value = level));
  voice.on("state", (state) => {
    talk.classList.toggle("on", state === "listening");
    if (state !== "listening") $("level").value = 0;
    $("talk-label").textContent = state === "listening" ? "Listening. Let go to send." : "Hold to talk";
    $("state").textContent = { idle: "Ready.", listening: "Listening.", transcribing: "Transcribing on this computer.", speaking: "Speaking." }[state];
    clearInterval(progressTimer);
    if (state === "transcribing") progressTimer = setInterval(showProgress, 300);
  });
}

function showProgress() {
  const status = voice.status()[0];
  if (status?.state === "loading") $("state").textContent = `Downloading the speech model: ${Math.round((status.progress ?? 0) * 100)} %`;
}

/** Ask the local model server through foxmind. Private mode: a cloud URL is skipped. */
async function reply(text) {
  const mind = createMind({
    providers: [openaiCompatible({ baseURL: fields.server.value, model: fields.model.value, checkModel: false, name: "model server" })],
    only: ["browser", "local"],
  });
  const messages = [
    { role: "system", content: "You are a voice assistant in a web browser. Answer in one or two short sentences." },
    { role: "user", content: text },
  ];
  try {
    const result = await mind.chat(messages, { maxTokens: 256, timeoutMs: 60000 });
    return { text: result.message.content?.trim() || "The model gave an empty answer.", who: `answered by ${result.provider} (${result.tier})` };
  } catch (error) {
    if (error.code !== "no_provider") throw error;
    return { text: `I heard you say: "${text}" No local model server is running, so I cannot answer yet.`, who: "no model answered: start llama-server or Ollama, or change the server in Settings" };
  }
}

async function start() {
  if (voice.state === "listening" || voice.state === "transcribing") return;
  $("mic-help").hidden = true;
  try {
    const heard = await voice.listen();
    const confidence = heard.confidence === undefined ? "" : `, confidence ${Math.round(heard.confidence * 100)} %`;
    show("transcript", heard.text, `${heard.provider} (${heard.tier})${confidence}, ${(heard.audioMs / 1000).toFixed(1)} s of audio in ${(heard.ms / 1000).toFixed(1)} s`);
    if (heard.confidence !== undefined && heard.confidence < 0.5) show("reply", "I am not sure what I heard. Please say it again.", "low confidence");
    else {
      $("state").textContent = "Asking the model.";
      const answer = await reply(heard.text);
      show("reply", answer.text, answer.who);
      if (fields.speak.checked) await voice.speak(answer.text);
    }
  } catch (error) {
    if (error.code === "aborted") return;
    $("state").textContent = error.message;
    if (["mic_denied", "no_microphone", "mic_busy", "unsupported"].includes(error.code)) {
      $("mic-error").textContent = error.message;
      $("mic-help").hidden = false;
    }
  }
}
const stop = () => voice.stop();

// Push to talk: pointer and Space. Leaving the button or the window lets go.
talk.addEventListener("pointerdown", (event) => {
  if (event.isTrusted) talk.setPointerCapture(event.pointerId);
  void start();
});
for (const name of ["pointerup", "pointercancel", "pointerleave"]) talk.addEventListener(name, stop);
talk.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat) return;
  event.preventDefault();
  void start();
});
talk.addEventListener("keyup", (event) => event.code === "Space" && stop());
window.addEventListener("blur", stop);
$("setup").addEventListener("click", () => browser.tabs.create({ url: browser.runtime.getURL("setup.html") }));

// Settings live in storage.local.
const saved = await browser.storage.local.get(["engine", "server", "model", "speak"]);
for (const [key, field] of Object.entries(fields)) {
  if (saved[key] !== undefined) field[field.type === "checkbox" ? "checked" : "value"] = saved[key];
  field.addEventListener("change", () => {
    void browser.storage.local.set({ [key]: field.type === "checkbox" ? field.checked : field.value });
    if (key === "engine") makeVoice();
  });
}
makeVoice();
