// The Node half of the E2E test: a real whisper.cpp whisper-server on this
// computer, through transcriptionServer(). It runs when whisper-server is on
// the PATH (brew install whisper-cpp), and downloads ggml-tiny.en.bin
// (78 MB) once into node_modules/.cache. Without it, the check is skipped
// and the artifact says why.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { whisperServer } from "../dist/index.js";
import { wordErrorRate } from "./hub.mjs";

const DIR = "node_modules/.cache/foxvoice-e2e";
const MODEL = `${DIR}/ggml-tiny.en.bin`;
const PORT = 8179;

/** 16-bit PCM mono WAV to samples from -1 to 1. */
function samples(path) {
  const bytes = readFileSync(path);
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset + 44, (bytes.length - 44) >> 1);
  return Float32Array.from(pcm, (value) => value / 32768);
}

export async function runNode(record, check, reference) {
  if (spawnSync("whisper-server", ["--help"]).error) {
    record.whisperServer = { skipped: "whisper-server is not on the PATH" };
    record.skipped.push({ name: "whisper-server on this computer", reason: "whisper-server is not on the PATH (brew install whisper-cpp)" });
    console.log("SKIP whisper-server on this computer: whisper-server is not on the PATH (brew install whisper-cpp)");
    return;
  }
  if (!existsSync(MODEL)) {
    mkdirSync(DIR, { recursive: true });
    const response = await fetch("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin");
    writeFileSync(MODEL, Buffer.from(await response.arrayBuffer()));
  }
  const server = spawn("whisper-server", ["-m", MODEL, "--port", String(PORT), "--inference-path", "/v1/audio/transcriptions"], { stdio: "ignore" });
  try {
    const provider = whisperServer({ port: PORT });
    const started = Date.now();
    while (!(await provider.probe()).ok && Date.now() - started < 30000) await new Promise((resolve) => setTimeout(resolve, 300));
    const begin = Date.now();
    const result = await provider.transcribe(samples("e2e/extension/jfk.wav"), {});
    const wer = wordErrorRate(reference, result.text);
    record.whisperServer = { model: "ggml-tiny.en.bin", tier: provider.tier, heard: result.text, wordErrorRate: wer, confidence: result.confidence, ms: Date.now() - begin };
    check("whisper-server on this computer: tier local, word error rate at most 10 %", provider.tier === "local" && wer <= 0.1 && result.confidence > 0.5, record.whisperServer);
  } finally {
    server.kill();
  }
}
