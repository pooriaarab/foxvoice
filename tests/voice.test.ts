// Failure modes R1-R5 and M6 (docs/failure-modes.md): createVoice with fake
// providers, a fake microphone and a fake speech engine.
import { afterEach, describe, expect, it } from "vitest";
import { FoxvoiceError, createVoice, transcriptionServer, type SttProvider, type Tier } from "../src/index.js";
import { fakeMedia, tone } from "./fake-media.js";
import { fakeServer, json } from "./fake-server.js";
import { FakeSynth, engine } from "./fake-speech.js";

function fake(name: string, tier: Tier, behaviour: { down?: boolean; fail?: boolean; text?: string } = {}) {
  const calls: string[] = [];
  const provider: SttProvider = {
    name,
    tier,
    model: `${name}-model`,
    probe: async () => {
      calls.push("probe");
      return behaviour.down ? { ok: false, code: "unreachable", reason: `${name} is down` } : { ok: true };
    },
    status: () => ({ name, tier, model: `${name}-model`, state: "idle" }),
    transcribe: async () => {
      calls.push("transcribe");
      if (behaviour.fail) throw new FoxvoiceError("http", `${name} broke`, { provider: name, tier });
      return { text: behaviour.text ?? `heard by ${name}`, confidence: 0.9 };
    },
  };
  return { provider, calls };
}
const audio = tone(1000);
const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("createVoice", () => {
  it("R1: private mode is the default: a cloud provider is never probed or called", async () => {
    const server = await fakeServer((_, res) => json(res, 200, { text: "cloud heard it" }));
    servers.push(server);
    const cloud = transcriptionServer({ baseURL: server.url, tier: "cloud" });
    const local = fake("local", "browser");
    const heard = await createVoice({ stt: [cloud, local.provider] }).transcribe(audio);
    expect(heard).toMatchObject({ text: "heard by local", provider: "local", tier: "browser" });
    expect(heard.skipped).toEqual([expect.objectContaining({ provider: "transcription-server", code: "private_mode" })]);
    expect(server.got).toHaveLength(0);
  });

  it("R1: the cloud tier runs only when the caller opts in", async () => {
    const cloud = fake("cloud", "cloud");
    expect((await createVoice({ stt: [cloud.provider], only: ["browser", "local", "cloud"] }).transcribe(audio)).provider).toBe("cloud");
  });

  it("R2: no provider can run gives no_provider with each reason", async () => {
    const voice = createVoice({ stt: [fake("a", "local", { down: true }).provider, fake("c", "cloud").provider] });
    await expect(voice.transcribe(audio)).rejects.toMatchObject({ code: "no_provider", message: expect.stringMatching(/a is down[\s\S]*private mode/) });
  });

  it("R3: a provider that is down is skipped and listed", async () => {
    const down = fake("down", "local", { down: true });
    const heard = await createVoice({ stt: [down.provider, fake("up", "browser").provider] }).transcribe(audio);
    expect(heard.provider).toBe("up");
    expect(heard.skipped).toEqual([{ provider: "down", code: "unreachable", reason: "down is down" }]);
  });

  it("R4: a failure during the call is thrown, and tries the next only with fallbackOnError", async () => {
    const broken = () => fake("broken", "local", { fail: true }).provider;
    const next = fake("next", "browser");
    await expect(createVoice({ stt: [broken(), next.provider] }).transcribe(audio)).rejects.toMatchObject({ code: "http" });
    expect(next.calls).toEqual([]);
    const heard = await createVoice({ stt: [broken(), next.provider], fallbackOnError: true }).transcribe(audio);
    expect(heard.provider).toBe("next");
    expect(heard.skipped[0]).toMatchObject({ provider: "broken", code: "http" });
  });

  it("R5: prefer changes the order, and never lets a dropped tier run", async () => {
    const browser = fake("browser-one", "browser");
    const local = fake("local-one", "local");
    const cloud = fake("cloud-one", "cloud");
    const voice = createVoice({ stt: [browser.provider, local.provider, cloud.provider], prefer: ["cloud", "local"] });
    expect((await voice.transcribe(audio)).provider).toBe("local-one");
    expect(cloud.calls).toEqual([]);
  });

  it("an empty transcript gives no_speech", async () => {
    await expect(createVoice({ stt: [fake("quiet", "browser", { text: "  " }).provider] }).transcribe(audio)).rejects.toMatchObject({ code: "no_speech" });
  });

  it("listen: the microphone, states and the transcript event", async () => {
    const { media } = fakeMedia(tone(1500));
    const voice = createVoice({ stt: [fake("local", "browser").provider], mic: { media } });
    const states: string[] = [];
    const transcripts: string[] = [];
    voice.on("state", (state) => states.push(state));
    voice.on("transcript", (heard) => transcripts.push(heard.text));
    const listening = voice.listen();
    await Promise.resolve();
    voice.stop();
    const heard = await listening;
    expect(heard).toMatchObject({ text: "heard by local", audioMs: 1500, stoppedBy: "user" });
    expect(states).toEqual(["listening", "transcribing", "idle"]);
    expect(transcripts).toEqual(["heard by local"]);
  });

  it("M6: listen while a session runs gives busy, and the first goes on", async () => {
    const { media } = fakeMedia();
    const voice = createVoice({ stt: [fake("local", "browser").provider], mic: { media } });
    const first = voice.listen();
    await expect(voice.listen()).rejects.toMatchObject({ code: "busy" });
    await Promise.resolve();
    voice.stop();
    expect((await first).text).toBe("heard by local");
  });

  it("cancel: listen rejects with aborted, an error event, and the state is idle", async () => {
    const { media } = fakeMedia();
    const voice = createVoice({ stt: [fake("local", "browser").provider], mic: { media } });
    const errors: string[] = [];
    voice.on("error", (error) => errors.push(error.code));
    const listening = voice.listen();
    await Promise.resolve();
    voice.cancel();
    await expect(listening).rejects.toMatchObject({ code: "aborted" });
    expect(errors).toEqual(["aborted"]);
    expect(voice.state).toBe("idle");
  });

  it("speak in private mode refuses a voice that is not local", async () => {
    const synth = new FakeSynth([{ name: "Cloud", voiceURI: "c", lang: "en-US", localService: false, default: true }]);
    const voice = createVoice({ stt: [], tts: { engine: engine(synth) } });
    await expect(voice.speak("hello")).rejects.toMatchObject({ code: "voice_not_local" });
    const open = createVoice({ stt: [], only: ["browser", "local", "cloud"], tts: { engine: engine(synth) } });
    expect((await open.speak("hello")).voice).toBe("Cloud");
  });
});
