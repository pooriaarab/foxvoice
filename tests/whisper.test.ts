// Failure mode W9 (docs/failure-modes.md). The E2E test covers W1-W8 with
// the real model in Firefox.
import { describe, expect, it } from "vitest";
import { whisper } from "../src/browser/index.js";
import { FoxvoiceError } from "../src/index.js";

describe("whisper", () => {
  it("W9: an English-only model refuses another language before any download", () => {
    expect(() => whisper({ model: "onnx-community/whisper-tiny.en", language: "fr" })).toThrow(FoxvoiceError);
    expect(() => whisper({ model: "onnx-community/whisper-tiny.en", language: "fr" })).toThrow(/English only/);
  });

  it("W9: a call that asks an English-only model for another language fails with unsupported", async () => {
    const provider = whisper();
    await expect(provider.transcribe(new Float32Array(16000), { language: "de" })).rejects.toMatchObject({ code: "unsupported" });
    expect(provider.status().state).toBe("idle");
  });

  it("describes itself as a browser-tier provider", () => {
    const provider = whisper();
    expect(provider.tier).toBe("browser");
    expect(provider.model).toBe("onnx-community/whisper-tiny.en");
  });
});
