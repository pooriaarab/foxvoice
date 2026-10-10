// The E2E test. It installs the E2E build (dist-e2e/: the demo extension
// plus the harness page from e2e/extension/) in a real Firefox, gives the
// microphone a known WAV file, and writes artifacts/e2e-<date>.json with
// every check and timing.
// Usage: pnpm e2e [--headed]. Env: FIREFOX (the Firefox binary).
import { launch, writeArtifact } from "create-foxkit/e2e";
import { startHub, wordErrorRate } from "./hub.mjs";
import { runNode } from "./node.mjs";

const record = { startedAt: new Date().toISOString(), checks: [], skipped: [], timings: {} };
const check = (name, ok, actual) => record.checks.push({ name, ok: Boolean(ok), actual });
/** Fail with the name of the call when a page call does not settle, not with Puppeteer's protocol timeout (H2). */
const within = (promise, seconds, what) => {
  let timer;
  const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} did not finish within ${seconds} s`)), seconds * 1000)));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};
// Firefox's fake media device answers getUserMedia without a prompt. The
// WAV microphone in e2e/extension/wav-mic.js replaces it where a check
// needs real speech.
const PREFS = {
  "media.navigator.streams.fake": true,
  "media.navigator.permission.disabled": true,
};

// jfk.wav: John F. Kennedy's inaugural address, 1961 (public domain), as
// whisper.cpp ships it in samples/jfk.wav.
const JFK = "And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country.";

const hub = await startHub();
let fox;
try {
  await runNode(record, check, JFK);
  fox = await launch({ extension: "dist-e2e", headless: !process.argv.includes("--headed"), prefs: PREFS });
  record.firefox = await fox.browser.version();
  const page = await fox.openExtensionPage("harness.html");
  const run = async (name, ...args) => {
    const started = Date.now();
    const value = await within(page.evaluate((n, a) => window.fv[n](...a), name, args), 300, `window.fv.${name}(${args.join(", ")})`);
    record.timings[[name, ...args].join(":")] = Date.now() - started;
    return value;
  };

  const env = await run("env");
  check("extension page has no SharedArrayBuffer (W4)", env.crossOriginIsolated === false && env.sharedArrayBuffer === "undefined", env);
  const device = await run("fakeDevice");
  check("fake device: getUserMedia gives a track that records", device.bytes > 0 && device.ended === "ended", device);
  const wav = await run("wavMic");
  check("WAV microphone: 11 s of 48 kHz audio decodes to 11 s at 16 kHz (M13)", wav.seconds > 10.9 && wav.seconds < 12.5 && wav.rate === 16000, wav);

  const stopped = await run("mic", "stop");
  check("push to talk: let go after the file gives 11 s of audio, microphone off (M5, M13)", stopped.stoppedBy === "user" && stopped.seconds > 10.5 && stopped.track === "ended", stopped);
  check("level events while the microphone is on", stopped.levels > 5 && stopped.level > 0.05, { levels: stopped.levels, level: stopped.level });
  const limit = await run("mic", "limit");
  check("time limit: stops at 3 s, microphone off (M5, M7)", limit.stoppedBy === "limit" && Math.abs(limit.seconds - 3) < 0.5 && limit.track === "ended", limit);
  const cancelled = await run("mic", "cancel");
  check("cancel: aborted, microphone off (M5, M10)", cancelled.outcome === "aborted" && cancelled.track === "ended", cancelled);
  const bad = await run("badAudio");
  check("bytes that are not audio give bad_audio (M12)", bad === "bad_audio", bad);

  await page.evaluate((url) => window.fv.useHub(url), hub.url);
  const before = hub.state.requests.filter((line) => line.startsWith("GET ") && line.endsWith(".onnx")).length;
  const twice = await run("whisper", "twice");
  const onnx = hub.state.requests.filter((line) => line.startsWith("GET ") && line.endsWith(".onnx")).length - before;
  check("two calls during the load: each model file fetched once, both transcripts (W3)", onnx === 2 && twice.one.text && twice.one.text === twice.two.text, { onnxRequests: onnx, one: twice.one.text, two: twice.two.text });
  const wer = wordErrorRate(JFK, twice.warm.text ?? "");
  record.accuracy = { model: twice.warm.status?.model, reference: JFK, heard: twice.warm.text, wordErrorRate: wer, confidence: twice.warm.confidence, where: twice.warm.status?.where };
  record.timings.whisperWarmMs = twice.warm.ms;
  check("jfk.wav word error rate at most 10 % on one WASM thread (W4, W8)", wer <= 0.1 && twice.warm.status?.where === "wasm", record.accuracy);
  check("speech gives confidence over 0.8 (W7)", twice.warm.confidence > 0.8, twice.warm.confidence);
  await page.evaluate(() => caches.delete("transformers-cache"));
  hub.state.cut = true;
  const cut = await run("whisper", "cut");
  hub.state.cut = false;
  const again = await run("whisper", "cut-again");
  check("downloads cut in half give download_failed, the next call downloads again (W1)", cut.code === "download_failed" && again.text, { first: cut.code, again: again.text });
  const noise = await run("whisper", "noise");
  check("noise gives confidence under 0.5 (W7)", noise.confidence < 0.5, { text: noise.text, confidence: noise.confidence });
  const long = await run("whisper", "long");
  check("33 s of audio gives too_long (W6)", long.code === "too_long", long.code);
  const gpu = await run("whisper", "webgpu");
  check("WebGPU asked where there is none gives webgpu_missing (W5)", gpu.hasGpu ? Boolean(gpu.text) : gpu.code === "webgpu_missing", { hasGpu: gpu.hasGpu, code: gpu.code, text: gpu.text });
  const missing = await run("whisper", "missing");
  check("a model that is not on the hub gives model_not_found (W2)", missing.code === "model_not_found", missing.code);
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  await fox?.close();
  await hub.close();
}
record.passed = !record.error && record.checks.length > 0 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
for (const s of record.skipped) console.log(`SKIP ${s.name}: ${s.reason}`);
console.log(`${record.passed ? "PASS" : "FAIL"} ${record.checks.filter((c) => c.ok).length}/${record.checks.length}${record.skipped.length ? `, ${record.skipped.length} skipped` : ""}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
