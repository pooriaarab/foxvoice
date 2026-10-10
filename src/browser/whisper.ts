// Whisper in the extension page with transformers.js. Extension pages have
// no SharedArrayBuffer, so ONNX Runtime runs on one WASM thread, from the
// files in the extension's ort/ folder (MV3 allows no remote code).
import { FoxvoiceError } from "../errors.js";
import type { Probe, SttProvider, SttStatus, TranscribeOptions, Transcription } from "../types.js";

type Transformers = typeof import("@huggingface/transformers");
type Tensor = import("@huggingface/transformers").Tensor;

export interface WhisperOptions {
  /** A Whisper ONNX model on the hub. Default "onnx-community/whisper-tiny.en" (English, about 43 MB at q8). */
  model?: string;
  /** "wasm" (default), "webgpu", or "auto": WebGPU when the browser has an adapter. */
  device?: "wasm" | "webgpu" | "auto";
  /** Default "q8" on WASM. On WebGPU: an fp32 encoder and a q4 decoder. */
  dtype?: string | Record<string, string>;
  /** The spoken language, for a multilingual model. English-only models (*.en) take only "en". */
  language?: string;
  /** The model hub. Default "https://huggingface.co/". */
  remoteHost?: string;
  /** Where ONNX Runtime's asyncify .mjs and .wasm files are. Default: ort/ in the extension. */
  wasmPaths?: { mjs: string; wasm: string };
  /** Default "whisper". */
  name?: string;
}

interface Loaded {
  processor: (audio: Float32Array) => Promise<Record<string, Tensor>>;
  tokenizer: { batch_decode(ids: Tensor, options: { skip_special_tokens: boolean }): string[]; all_special_ids: number[] };
  model: {
    generate(inputs: Record<string, unknown>): Promise<unknown>;
    (inputs: Record<string, unknown>): Promise<{ logits: Tensor }>;
  };
}

const MAX_SAMPLES = 30 * 16000;
let transformers: Promise<Transformers> | undefined;

const extensionUrl = (path: string) => (globalThis as { browser?: { runtime?: { getURL?(p: string): string } } }).browser?.runtime?.getURL?.(path);

function runtime(wasmPaths: WhisperOptions["wasmPaths"]): Promise<Transformers> {
  transformers ??= import("@huggingface/transformers").then((module) => {
    const { env } = module;
    env.allowLocalModels = false;
    env.useWasmCache = false;
    const wasm = env.backends.onnx.wasm;
    const mjs = extensionUrl("ort/ort-wasm-simd-threaded.asyncify.mjs");
    const paths = wasmPaths ?? (mjs ? { mjs, wasm: extensionUrl("ort/ort-wasm-simd-threaded.asyncify.wasm") ?? "" } : undefined);
    if (wasm && paths) wasm.wasmPaths = paths;
    if (wasm && !globalThis.crossOriginIsolated) wasm.numThreads = 1;
    return module;
  });
  return transformers;
}

async function gpuAdapter(): Promise<boolean> {
  const gpu = (globalThis.navigator as { gpu?: { requestAdapter(): Promise<unknown> } } | undefined)?.gpu;
  return Boolean(gpu && (await gpu.requestAdapter().catch(() => null)));
}

function modelError(error: unknown, model: string): FoxvoiceError {
  if (error instanceof FoxvoiceError) return error;
  const said = error instanceof Error ? error.message : String(error);
  const details = { provider: "whisper", tier: "browser" as const, cause: error };
  if (/out of memory|allocation failed|could not allocate|memory access out of bounds|device (was )?lost/i.test(said)) return new FoxvoiceError("out_of_memory", `${model} needs more memory than this device has (${said}). Try a smaller model.`, details);
  if (/Could not locate file|Unauthorized access|Forbidden access|404|401/i.test(said)) return new FoxvoiceError("model_not_found", `The hub has no ${model}, or it is private: ${said}`, details);
  if (/NetworkError|Failed to fetch|network|body stream|input stream|terminated|load failed|aborted|502|503/i.test(said)) return new FoxvoiceError("download_failed", `The download of ${model} stopped: ${said}. Call again to download it again.`, details);
  return new FoxvoiceError("bad_response", `${model} failed: ${said}`, details);
}

/** Wait for work, but stop waiting at the caller's abort or after timeoutMs. ONNX Runtime cannot stop mid-run. */
function bounded<T>(work: Promise<T>, { signal, timeoutMs }: TranscribeOptions): Promise<T> {
  if (!signal && timeoutMs === undefined) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    const abort = () => reject(new FoxvoiceError("aborted", "The caller stopped the call.", { provider: "whisper", tier: "browser" }));
    onAbort = abort;
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (timeoutMs !== undefined) timer = setTimeout(() => reject(new FoxvoiceError("timeout", `No transcript within ${timeoutMs} ms.`, { provider: "whisper", tier: "browser" })), timeoutMs);
  });
  return Promise.race([work, stopped]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  });
}

/** Whisper speech to text in the browser: tier "browser", nothing leaves the page. */
export function whisper(options: WhisperOptions = {}): SttProvider {
  const { model = "onnx-community/whisper-tiny.en", device = "wasm", name = "whisper" } = options;
  const englishOnly = model.endsWith(".en");
  const checkLanguage = (language: string | undefined) => {
    if (englishOnly && language && language !== "en") throw new FoxvoiceError("unsupported", `${model} is English only and cannot transcribe "${language}". Use a multilingual model such as onnx-community/whisper-base.`, { provider: name, tier: "browser" });
  };
  checkLanguage(options.language);
  const state: Omit<SttStatus, "name" | "tier" | "model"> = { state: "idle" };
  let pending: Promise<Loaded> | undefined;

  async function open(): Promise<Loaded> {
    const useGpu = device === "webgpu" || (device === "auto" && (await gpuAdapter()));
    if (device === "webgpu" && !(await gpuAdapter())) throw new FoxvoiceError("webgpu_missing", "This browser gives no WebGPU adapter (Firefox has none on Linux, Intel Macs, Android and in headless mode). Use device \"wasm\".", { provider: name, tier: "browser" });
    Object.assign(state, { state: "loading", where: useGpu ? "webgpu" : "wasm", progress: 0 });
    const t = await runtime(options.wasmPaths);
    t.env.remoteHost = options.remoteHost ?? "https://huggingface.co/";
    const files = new Map<string, [number, number]>();
    const progress_callback = (info: { status?: string; file?: string; loaded?: number; total?: number }) => {
      if (info.status !== "progress" || !info.file || !info.total) return;
      files.set(info.file, [info.loaded ?? 0, info.total]);
      const [loaded, total] = [...files.values()].reduce((sum, [l, all]) => [sum[0] + l, sum[1] + all], [0, 0]);
      state.progress = loaded / total;
    };
    const dtype = options.dtype ?? (useGpu ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8");
    const [processor, tokenizer, whisperModel] = await Promise.all([
      t.AutoProcessor.from_pretrained(model, { progress_callback }),
      t.AutoTokenizer.from_pretrained(model, { progress_callback }),
      t.WhisperForConditionalGeneration.from_pretrained(model, { dtype, device: useGpu ? "webgpu" : "wasm", progress_callback } as never),
    ]);
    return { processor, tokenizer, model: whisperModel } as unknown as Loaded;
  }

  function load(): Promise<Loaded> {
    pending ??= open().then(
      (loaded) => {
        Object.assign(state, { state: "ready", progress: 1 });
        return loaded;
      },
      (error: unknown) => {
        pending = undefined;
        const mapped = modelError(error, model);
        Object.assign(state, { state: "error", reason: mapped.message });
        throw mapped;
      },
    );
    return pending;
  }

  /** The mean probability the model gave each word piece it wrote, from one more decoder pass. */
  async function confidence(loaded: Loaded, inputs: Record<string, Tensor>, sequence: Tensor): Promise<number> {
    const { logits } = await loaded.model({ ...inputs, decoder_input_ids: sequence });
    const [, steps = 0, vocab = 0] = logits.dims;
    const data = logits.data as Float32Array;
    const ids = Array.from(sequence.data as BigInt64Array, Number);
    const special = new Set(loaded.tokenizer.all_special_ids);
    const probabilities: number[] = [];
    for (let step = 0; step < steps - 1; step++) {
      const next = ids[step + 1] ?? 0;
      if (special.has(next)) continue;
      const row = data.subarray(step * vocab, (step + 1) * vocab);
      let max = -Infinity;
      for (const value of row) max = Math.max(max, value);
      let sum = 0;
      for (const value of row) sum += Math.exp(value - max);
      probabilities.push(Math.exp((row[next] ?? -Infinity) - max) / sum);
    }
    return probabilities.length ? probabilities.reduce((a, b) => a + b, 0) / probabilities.length : 0;
  }

  return {
    name,
    tier: "browser",
    model,
    async probe(): Promise<Probe> {
      if (typeof WebAssembly === "undefined") return { ok: false, code: "unsupported", reason: "This page has no WebAssembly." };
      if (device === "webgpu" && !(await gpuAdapter())) return { ok: false, code: "webgpu_missing", reason: "This browser gives no WebGPU adapter." };
      return { ok: true, where: state.where ?? (device === "webgpu" ? "webgpu" : "wasm") };
    },
    status: () => ({ name, tier: "browser", model, ...state }),
    async load(callOptions = {}) {
      await bounded(load(), callOptions);
    },
    async transcribe(audio: Float32Array, callOptions: TranscribeOptions): Promise<Transcription> {
      const language = callOptions.language ?? options.language;
      checkLanguage(language);
      if (audio.length > MAX_SAMPLES) throw new FoxvoiceError("too_long", `The audio is ${(audio.length / 16000).toFixed(1)} s long. Whisper takes at most 30 s at a time.`, { provider: name, tier: "browser" });
      const loaded = await bounded(load(), callOptions);
      const run = async () => {
        const inputs = await loaded.processor(audio);
        const sequence = (await loaded.model.generate({ ...inputs, ...(englishOnly || !language ? {} : { language, task: "transcribe" }) })) as Tensor;
        const text = (loaded.tokenizer.batch_decode(sequence, { skip_special_tokens: true })[0] ?? "").trim();
        return { text, confidence: text ? await confidence(loaded, inputs, sequence) : 0 };
      };
      return bounded(run().catch((error: unknown) => Promise.reject(modelError(error, model))), callOptions);
    },
  };
}
