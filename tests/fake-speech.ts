// A fake speechSynthesis with the parts foxvoice uses. Voices can arrive
// late, as in Firefox, and each utterance ends, fails or hangs on demand.

export interface FakeVoice {
  name: string;
  voiceURI: string;
  lang: string;
  localService: boolean;
  default: boolean;
}

export const voice = (name: string, lang: string, localService = true, isDefault = false): FakeVoice => ({ name, voiceURI: `urn:${name}`, lang, localService, default: isDefault });

export class FakeUtterance extends EventTarget {
  voice: FakeVoice | null = null;
  lang = "";
  rate = 1;
  pitch = 1;
  volume = 1;
  constructor(readonly text: string) {
    super();
  }
}

export class FakeSynth extends EventTarget {
  spoken: FakeUtterance[] = [];
  cancelled = 0;
  /** What the next utterance does: "end", an error name such as "synthesis-failed", or "hang". */
  outcome = "end";
  speaking = false;
  constructor(private list: FakeVoice[] = [voice("Samantha", "en-US", true, true)]) {
    super();
  }
  getVoices() {
    return this.list;
  }
  /** Firefox fills the list later and fires voiceschanged. */
  arrive(list: FakeVoice[]) {
    this.list = list;
    this.dispatchEvent(new Event("voiceschanged"));
  }
  speak(utterance: FakeUtterance) {
    this.spoken.push(utterance);
    this.speaking = true;
    const outcome = this.outcome;
    setTimeout(() => {
      if (!this.speaking) return;
      utterance.dispatchEvent(new Event("start"));
      if (outcome === "hang") return;
      this.speaking = false;
      utterance.dispatchEvent(outcome === "end" ? new Event("end") : Object.assign(new Event("error"), { error: outcome }));
    }, 5);
  }
  cancel() {
    this.cancelled += 1;
    if (!this.speaking) return;
    this.speaking = false;
    const last = this.spoken.at(-1);
    last?.dispatchEvent(Object.assign(new Event("error"), { error: "interrupted" }));
  }
}

export const engine = (synth: FakeSynth) => ({ synth: synth as unknown as SpeechSynthesis, Utterance: FakeUtterance as unknown as typeof SpeechSynthesisUtterance });
