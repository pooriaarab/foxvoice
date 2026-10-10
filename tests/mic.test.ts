// Failure modes M1-M14 that a unit test reaches (docs/failure-modes.md).
// The E2E test covers the rest with the real Firefox media stack.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FoxvoiceError, openMic } from "../src/index.js";
import { FakeRecorder, fakeMedia, refusing, tone } from "./fake-media.js";

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FoxvoiceError);
    return (error as FoxvoiceError).code;
  }
  throw new Error("expected a FoxvoiceError");
};

afterEach(() => {
  FakeRecorder.bytes = 1000;
  vi.useRealTimers();
});

describe("microphone", () => {
  it("M1: no mediaDevices gives unsupported", async () => {
    expect(await code(openMic())).toBe("unsupported");
  });

  it("M1: no MediaRecorder gives unsupported and asks for no microphone", async () => {
    const { media, streams } = fakeMedia();
    expect(await code(openMic({ media: { ...media, MediaRecorder: undefined } }))).toBe("unsupported");
    expect(streams).toHaveLength(0);
  });

  it.each([
    ["NotAllowedError", "mic_denied"],
    ["SecurityError", "mic_denied"],
    ["NotFoundError", "no_microphone"],
    ["OverconstrainedError", "no_microphone"],
    ["NotReadableError", "mic_busy"],
    ["AbortError", "mic_busy"],
  ])("M2-M4: getUserMedia %s gives %s", async (name, wanted) => {
    const { media } = fakeMedia();
    const opening = openMic({ media: { ...media, getUserMedia: refusing(name) } });
    expect(await code(opening)).toBe(wanted);
    if (wanted === "mic_denied") await expect(opening).rejects.toThrow(/allow it/);
  });

  it("records until stop and gives 16 kHz audio", async () => {
    const { media, streams } = fakeMedia(tone(1200));
    const mic = await openMic({ media });
    mic.stop();
    const recording = await mic.done;
    expect(recording.sampleRate).toBe(16000);
    expect(recording.ms).toBe(1200);
    expect(recording.stoppedBy).toBe("user");
    expect(streams[0]?.tracks[0]?.readyState).toBe("ended");
  });

  it("M5 and M8: a press shorter than minMs gives too_short and the microphone goes off", async () => {
    const { media, streams } = fakeMedia(tone(100));
    const mic = await openMic({ media });
    mic.stop();
    expect(await code(mic.done)).toBe("too_short");
    expect(streams[0]?.tracks[0]?.readyState).toBe("ended");
  });

  it("M8: no bytes from the recorder gives too_short", async () => {
    FakeRecorder.bytes = 0;
    const { media } = fakeMedia();
    const mic = await openMic({ media });
    mic.stop();
    expect(await code(mic.done)).toBe("too_short");
  });

  it("M5 and M9: silence gives no_speech and the microphone goes off", async () => {
    const { media, streams } = fakeMedia(tone(2000, 0));
    const mic = await openMic({ media });
    mic.stop();
    expect(await code(mic.done)).toBe("no_speech");
    expect(streams[0]?.tracks[0]?.readyState).toBe("ended");
  });

  it("M5 and M12: audio that does not decode gives bad_audio and the microphone goes off", async () => {
    const { media, streams } = fakeMedia();
    const mic = await openMic({ media: { ...media, decode: async () => { throw new Error("EncodingError"); } } });
    mic.stop();
    expect(await code(mic.done)).toBe("bad_audio");
    expect(streams[0]?.tracks[0]?.readyState).toBe("ended");
  });

  it("M7: the time limit stops the microphone", async () => {
    vi.useFakeTimers();
    const { media, streams } = fakeMedia();
    const mic = await openMic({ media, maxMs: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    const recording = await mic.done;
    expect(recording.stoppedBy).toBe("limit");
    expect(streams[0]?.tracks[0]?.readyState).toBe("ended");
  });

  it("M10: cancel gives aborted and the microphone goes off", async () => {
    const { media, streams } = fakeMedia();
    const mic = await openMic({ media });
    mic.cancel();
    expect(await code(mic.done)).toBe("aborted");
    expect(streams[0]?.tracks[0]?.readyState).toBe("ended");
  });

  it("M11: the caller's AbortSignal gives aborted", async () => {
    const { media, streams } = fakeMedia();
    const controller = new AbortController();
    const mic = await openMic({ media, signal: controller.signal });
    controller.abort();
    expect(await code(mic.done)).toBe("aborted");
    expect(streams[0]?.tracks[0]?.readyState).toBe("ended");
  });

  it("M11: a signal that is already aborted asks for no microphone", async () => {
    const { media, streams } = fakeMedia();
    expect(await code(openMic({ media, signal: AbortSignal.abort() }))).toBe("aborted");
    expect(streams).toHaveLength(0);
  });

  it("M14: an unplugged device stops and keeps what came before", async () => {
    const { media, streams } = fakeMedia();
    const mic = await openMic({ media });
    streams[0]?.tracks[0]?.unplug();
    const recording = await mic.done;
    expect(recording.stoppedBy).toBe("device");
    expect(recording.audio.length).toBe(16000);
  });
});
