// Failure modes T1-T7 (docs/failure-modes.md) with a fake speech engine.
import { describe, expect, it, vi } from "vitest";
import { FoxvoiceError, speak } from "../src/index.js";
import { FakeSynth, engine, voice } from "./fake-speech.js";

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => {
      expect(error).toBeInstanceOf(FoxvoiceError);
      return (error as FoxvoiceError).code;
    },
  );

describe("speak", () => {
  it("speaks with the default local voice and says which one", async () => {
    const synth = new FakeSynth([voice("Fred", "en-US"), voice("Samantha", "en-US", true, true)]);
    const spoken = await speak("Your mail is open.", { engine: engine(synth), rate: 1.2 });
    expect(spoken).toMatchObject({ voice: "Samantha", lang: "en-US", local: true });
    expect(synth.spoken[0]?.text).toBe("Your mail is open.");
    expect(synth.spoken[0]?.rate).toBe(1.2);
  });

  it("picks a voice for the language asked", async () => {
    const synth = new FakeSynth([voice("Samantha", "en-US", true, true), voice("Thomas", "fr-FR")]);
    expect((await speak("Bonjour", { engine: engine(synth), lang: "fr" })).voice).toBe("Thomas");
  });

  it("T1: no speechSynthesis gives unsupported", async () => {
    expect(await code(speak("hello"))).toBe("unsupported");
  });

  it("T2: voices that arrive late are waited for", async () => {
    const synth = new FakeSynth([]);
    setTimeout(() => synth.arrive([voice("Samantha", "en-US", true, true)]), 50);
    expect((await speak("hello", { engine: engine(synth) })).voice).toBe("Samantha");
  });

  it("T2: no voices after 2 s gives no_voice", async () => {
    vi.useFakeTimers();
    const pending = code(speak("hello", { engine: engine(new FakeSynth([])) }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toBe("no_voice");
    vi.useRealTimers();
  });

  it("T3: a chosen voice that is not on the device gives voice_not_local and says nothing", async () => {
    const synth = new FakeSynth([voice("Cloud", "en-US", false), voice("Samantha", "en-US", true, true)]);
    expect(await code(speak("hello", { engine: engine(synth), voice: "Cloud" }))).toBe("voice_not_local");
    expect(synth.spoken).toHaveLength(0);
  });

  it("T3: without a chosen voice, a local voice wins over a default cloud voice", async () => {
    const synth = new FakeSynth([voice("Cloud", "en-US", false, true), voice("Fred", "en-US")]);
    expect((await speak("hello", { engine: engine(synth) })).voice).toBe("Fred");
  });

  it("T3: with only cloud voices, private mode gives voice_not_local; localOnly false allows them", async () => {
    const synth = new FakeSynth([voice("Cloud", "en-US", false, true)]);
    expect(await code(speak("hello", { engine: engine(synth) }))).toBe("voice_not_local");
    expect((await speak("hello", { engine: engine(synth), localOnly: false })).local).toBe(false);
  });

  it("T4: an engine error gives tts_failed with the error name", async () => {
    const synth = new FakeSynth();
    synth.outcome = "synthesis-failed";
    await expect(speak("hello", { engine: engine(synth) })).rejects.toMatchObject({ code: "tts_failed", message: expect.stringContaining("synthesis-failed") });
  });

  it("T5: abort stops the speech and gives aborted", async () => {
    const synth = new FakeSynth();
    synth.outcome = "hang";
    const controller = new AbortController();
    const pending = code(speak("a long answer", { engine: engine(synth), signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    expect(await pending).toBe("aborted");
    expect(synth.cancelled).toBe(1);
  });

  it("T6: empty text gives bad_input", async () => {
    expect(await code(speak("   ", { engine: engine(new FakeSynth()) }))).toBe("bad_input");
  });

  it("T7: an engine that never ends gives timeout and is cancelled", async () => {
    const synth = new FakeSynth();
    synth.outcome = "hang";
    expect(await code(speak("hello", { engine: engine(synth), timeoutMs: 100 }))).toBe("timeout");
    expect(synth.cancelled).toBe(1);
  });
});
