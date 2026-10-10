// Text to speech with the browser's speechSynthesis. Firefox speaks with
// the voices of the operating system. A voice whose localService is false
// sends the text to a server, so private mode refuses it.
// Each text is spoken in its own hidden iframe: after cancel() during
// speech, Firefox can leave a page's speech queue stuck for good (T9).
import { FoxvoiceError } from "./errors.js";

export interface SpeakOptions {
  /** A voice name or voiceURI. Default: a local voice for `lang`, the system default first. */
  voice?: string;
  /** A language such as "en" or "fr-FR". Picks the voice and sets the utterance language. */
  lang?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  /** Refuse voices that are not on the device. Default true (private mode). */
  localOnly?: boolean;
  signal?: AbortSignal;
  /** Fail with timeout when the engine sends no end. Default: 5 s plus 200 ms per character. */
  timeoutMs?: number;
  /** Another engine, for tests. Default: the page's speechSynthesis. */
  engine?: { synth: SpeechSynthesis; Utterance: typeof SpeechSynthesisUtterance };
}

export interface Spoken {
  voice: string;
  lang: string;
  /** True when the voice runs on this device. */
  local: boolean;
  ms: number;
}

const VOICE_WAIT_MS = 2000;

/** The voices, after Firefox has filled the list (it is empty at first). */
export async function listVoices(synth: SpeechSynthesis = globalThis.speechSynthesis): Promise<SpeechSynthesisVoice[]> {
  if (!synth) throw new FoxvoiceError("unsupported", "This page has no speechSynthesis.");
  const now = synth.getVoices();
  if (now.length) return now;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      synth.removeEventListener("voiceschanged", done);
      resolve(synth.getVoices());
    };
    const timer = setTimeout(done, VOICE_WAIT_MS);
    synth.addEventListener("voiceschanged", done);
  });
}

function pickVoice(voices: SpeechSynthesisVoice[], options: SpeakOptions, localOnly: boolean): SpeechSynthesisVoice {
  if (!voices.length) throw new FoxvoiceError("no_voice", "This system has no speech voices. On Linux, install speech-dispatcher and a voice such as espeak-ng.");
  if (options.voice) {
    const chosen = voices.find((v) => v.name === options.voice || v.voiceURI === options.voice);
    if (!chosen) throw new FoxvoiceError("no_voice", `There is no voice named "${options.voice}".`);
    if (localOnly && !chosen.localService) throw new FoxvoiceError("voice_not_local", `The voice "${chosen.name}" is not on this device, so the text would leave it. Choose a local voice, or set localOnly: false.`);
    return chosen;
  }
  const lang = options.lang?.toLowerCase();
  const fits = voices.filter((v) => (!localOnly || v.localService) && (!lang || v.lang.toLowerCase().startsWith(lang)));
  const best = fits.find((v) => v.default) ?? fits.find((v) => v.localService) ?? fits[0];
  if (best) return best;
  if (localOnly && voices.some((v) => !v.localService && (!lang || v.lang.toLowerCase().startsWith(lang)))) {
    throw new FoxvoiceError("voice_not_local", `Every voice${lang ? ` for "${lang}"` : ""} on this system sends the text to a server. Set localOnly: false to allow that.`);
  }
  throw new FoxvoiceError("no_voice", `There is no voice for "${options.lang}".`);
}

/** The page's engine, from a new hidden iframe when there is a document. */
function pageEngine(): { synth?: SpeechSynthesis; Utterance?: typeof SpeechSynthesisUtterance; dispose(): void } {
  const body = globalThis.document?.body;
  if (!body || !globalThis.speechSynthesis) return { synth: globalThis.speechSynthesis, Utterance: globalThis.SpeechSynthesisUtterance, dispose() {} };
  const frame = document.createElement("iframe");
  frame.hidden = true;
  body.append(frame);
  const view = frame.contentWindow as (Window & typeof globalThis) | null;
  return { synth: view?.speechSynthesis, Utterance: view?.SpeechSynthesisUtterance, dispose: () => frame.remove() };
}

/** Speak text aloud. Resolves when the speech ends. */
export async function speak(text: string, options: SpeakOptions = {}): Promise<Spoken> {
  if (!text.trim()) throw new FoxvoiceError("bad_input", "There is no text to speak.");
  if (options.signal?.aborted) throw new FoxvoiceError("aborted", "The speech was cancelled.");
  const engine = options.engine ? { ...options.engine, dispose() {} } : pageEngine();
  try {
    return await speakWith(engine.synth, engine.Utterance, text, options);
  } finally {
    engine.dispose();
  }
}

async function speakWith(synth: SpeechSynthesis | undefined, Utterance: typeof SpeechSynthesisUtterance | undefined, text: string, options: SpeakOptions): Promise<Spoken> {
  const { localOnly = true, signal } = options;
  if (!synth || !Utterance) throw new FoxvoiceError("unsupported", "This page has no speechSynthesis.");
  const chosen = pickVoice(await listVoices(synth), options, localOnly);
  if (signal?.aborted) throw new FoxvoiceError("aborted", "The speech was cancelled.");
  const utterance = new Utterance(text);
  utterance.voice = chosen;
  utterance.lang = options.lang ?? chosen.lang;
  if (options.rate !== undefined) utterance.rate = options.rate;
  if (options.pitch !== undefined) utterance.pitch = options.pitch;
  if (options.volume !== undefined) utterance.volume = options.volume;
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 5000 + 200 * text.length;

  return new Promise<Spoken>((resolve, reject) => {
    let stopping: FoxvoiceError | undefined;
    const stop = (error: FoxvoiceError) => {
      stopping = error;
      synth.cancel();
      // An engine that never started sends no error event after cancel.
      finish(() => reject(error));
    };
    const onAbort = () => stop(new FoxvoiceError("aborted", "The speech was cancelled."));
    const timer = setTimeout(() => stop(new FoxvoiceError("timeout", `The speech engine sent no end within ${timeoutMs} ms.`)), timeoutMs);
    let finished = false;
    const finish = (settle: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    utterance.addEventListener("end", () => finish(() => resolve({ voice: chosen.name, lang: utterance.lang, local: chosen.localService, ms: Date.now() - started })));
    utterance.addEventListener("error", (event) => {
      const name = (event as SpeechSynthesisErrorEvent).error;
      finish(() => reject(stopping ?? new FoxvoiceError("tts_failed", `The speech engine failed: ${name}.`)));
    });
    synth.speak(utterance);
  });
}
