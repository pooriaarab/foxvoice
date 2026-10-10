// The E2E test. It installs the E2E build (dist-e2e/: the demo extension
// plus the harness page from e2e/extension/) in a real Firefox, gives the
// microphone a known WAV file, and writes artifacts/e2e-<date>.json with
// every check and timing.
// Usage: pnpm e2e [--headed]. Env: FIREFOX (the Firefox binary).
import { launch, writeArtifact } from "create-foxkit/e2e";

const record = { startedAt: new Date().toISOString(), checks: [], timings: {} };
const check = (name, ok, actual) => record.checks.push({ name, ok: Boolean(ok), actual });
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
    const value = await page.evaluate((n, a) => window.fv[n](...a), name, args);
    record.timings[name] = Date.now() - started;
    return value;
  };

  const env = await run("env");
  check("extension page has no SharedArrayBuffer (W4)", env.crossOriginIsolated === false && env.sharedArrayBuffer === "undefined", env);
  const device = await run("fakeDevice");
  check("fake device: getUserMedia gives a track that records", device.bytes > 0 && device.ended === "ended", device);
  const wav = await run("wavMic");
  check("WAV microphone: 11 s of 48 kHz audio decodes to 11 s at 16 kHz (M13)", Math.abs(wav.seconds - 11) < 0.3 && wav.rate === 16000, wav);
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  await fox?.close();
}
record.passed = !record.error && record.checks.length > 0 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
console.log(`${record.passed ? "PASS" : "FAIL"} ${record.checks.filter((c) => c.ok).length}/${record.checks.length}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
