// The E2E test. It installs the E2E build (dist-e2e/: the demo extension
// plus the harness page from e2e/extension/) in a real Firefox, gives the
// microphone a known WAV file, and writes artifacts/e2e-<date>.json with
// every check and timing.
// Usage: pnpm e2e [--headed]. Env: FIREFOX (the Firefox binary).
import { launch, writeArtifact } from "create-foxkit/e2e";

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

let fox;
try {
  fox = await launch({ extension: "dist-e2e", headless: !process.argv.includes("--headed"), prefs: PREFS });
  record.firefox = await fox.browser.version();
  const page = await fox.openExtensionPage("harness.html");
  const run = async (name, ...args) => {
    const started = Date.now();
    const value = await within(page.evaluate((n, a) => window.fv[n](...a), name, args), 300, `window.fv.${name}(${args.join(", ")})`);
    record.timings[name] = Date.now() - started;
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
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  await fox?.close();
}
record.passed = !record.error && record.checks.length > 0 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
for (const s of record.skipped) console.log(`SKIP ${s.name}: ${s.reason}`);
console.log(`${record.passed ? "PASS" : "FAIL"} ${record.checks.filter((c) => c.ok).length}/${record.checks.length}${record.skipped.length ? `, ${record.skipped.length} skipped` : ""}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
