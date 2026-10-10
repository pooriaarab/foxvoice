// Builds extension/ into dist-ext/: esbuild bundles each script, and the
// other files are copied. It stops when the manifest version is not the
// package.json version, so AMO signs the version that npm publishes.
// --e2e builds dist-e2e/: the same plus the harness page, the WAV
// microphone and the test audio from e2e/extension/ (never in dist-ext/).
// Scripts are ES modules: pages load them with <script type="module">.
import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`extension/manifest.json has version ${manifest.version}, but package.json has ${pkg.version}. Make them equal.`);
  process.exit(1);
}

const e2e = process.argv.includes("--e2e");
const out = e2e ? "dist-e2e" : "dist-ext";
const dirs = e2e ? ["extension", "e2e/extension"] : ["extension"];
rmSync(out, { recursive: true, force: true });
for (const dir of dirs) {
  const files = readdirSync(dir);
  await build({
    entryPoints: files.filter((f) => f.endsWith(".js")).map((f) => `${dir}/${f}`),
    outdir: out,
    bundle: true,
    format: "esm",
    target: "firefox153",
    logLevel: "warning",
  });
  // amo-metadata.json is the AMO listing, not a part of the add-on.
  for (const file of files.filter((f) => !f.endsWith(".js") && f !== "amo-metadata.json")) cpSync(`${dir}/${file}`, `${out}/${file}`, { recursive: true });
}
// ONNX Runtime's WASM files ship in the extension: MV3 allows no remote code.
const ort = join(dirname(dirname(realpathSync("node_modules/@huggingface/transformers"))), "onnxruntime-web", "dist");
mkdirSync(`${out}/ort`);
for (const file of ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"]) cpSync(join(ort, file), `${out}/ort/${file}`);
console.log(`Built ${out}/ (version ${pkg.version}).`);
