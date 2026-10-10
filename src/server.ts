// Speech to text on a server with the OpenAI transcription API: whisper.cpp's
// whisper-server on this computer, or a cloud service with your own key.
import { encodeWav } from "./audio.js";
import { FoxvoiceError, type ErrorCode } from "./errors.js";
import type { Probe, SttProvider, SttStatus, Tier, TranscribeOptions, Transcription } from "./types.js";

export interface TranscriptionServerOptions {
  /** The API root, for example "http://127.0.0.1:8178/v1" or "https://api.openai.com/v1". */
  baseURL: string;
  /** The model name the server wants. Default "whisper-1". */
  model?: string;
  /** Your own key. Sent as a Bearer token. Never kept by foxvoice and never in an error message. */
  apiKey?: string;
  /**
   * The tier comes from the URL: localhost, 127.0.0.1 and [::1] are "local",
   * any other host is "cloud". Set "cloud" for a local server that forwards
   * audio to another computer.
   */
  tier?: "cloud";
  /** "verbose_json" (default) gives confidence. Use "json" for servers without it. */
  responseFormat?: "verbose_json" | "json";
  /** Default "transcription-server". */
  name?: string;
  /** Default 60000. */
  timeoutMs?: number;
  /** Added to probe failures: how to start the server. */
  startHint?: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A server with the OpenAI /audio/transcriptions API. */
export function transcriptionServer(options: TranscriptionServerOptions): SttProvider {
  const { model = "whisper-1", apiKey, responseFormat = "verbose_json", name = "transcription-server", timeoutMs = 60000 } = options;
  const baseURL = options.baseURL.replace(/\/+$/, "");
  const url = new URL(baseURL);
  const local = LOCAL_HOSTS.has(url.hostname);
  const tier: Tier = local && options.tier !== "cloud" ? "local" : "cloud";
  const origin = { provider: name, tier };
  if (apiKey && url.protocol === "http:" && !local) throw new FoxvoiceError("insecure", `${name} would send your key over plain http to ${url.host}. Use https.`, origin);
  const hide = (text: string) => (apiKey ? text.split(apiKey).join("[key]") : text);
  const error = (code: ErrorCode, message: string, extra: { retryAfterMs?: number; cause?: unknown } = {}) => new FoxvoiceError(code, hide(message), { ...origin, ...extra });
  const hint = options.startHint ? ` ${options.startHint}` : "";
  let state: Pick<SttStatus, "state" | "reason"> = { state: "idle" };

  /** fetch with a timeout, the caller's abort, and no redirects: a redirect could send the audio to another host. */
  async function call(path: string, init: RequestInit, limits: TranscribeOptions): Promise<Response> {
    const timeout = AbortSignal.timeout(limits.timeoutMs ?? timeoutMs);
    const signal = limits.signal ? AbortSignal.any([limits.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(`${baseURL}${path}`, { ...init, signal, redirect: "manual" });
    } catch (cause) {
      if (limits.signal?.aborted) throw error("aborted", "The caller stopped the call.", { cause });
      if (timeout.aborted) throw error("timeout", `${name} did not answer within ${limits.timeoutMs ?? timeoutMs} ms.`, { cause });
      throw error("unreachable", `Cannot reach ${baseURL}: ${cause instanceof Error ? (cause.cause as Error | undefined)?.message ?? cause.message : String(cause)}.${hint}`, { cause });
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      throw error("http", `${name} answered with a redirect (${response.status}). foxvoice does not follow it, so the audio goes nowhere else.`);
    }
    return response;
  }

  async function failure(response: Response): Promise<FoxvoiceError> {
    const body = await response.text().catch(() => "");
    const said = `${name} answered ${response.status}: ${body.slice(0, 300)}`;
    if (response.status === 401 || response.status === 403) return error("auth", said);
    if (response.status === 404) return error("model_not_found", said);
    if (response.status === 429) {
      const header = response.headers.get("retry-after");
      const seconds = Number(header);
      const retryAfterMs = header === null ? undefined : Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(header) - Date.now()) || undefined;
      return error("rate_limited", said, retryAfterMs === undefined ? {} : { retryAfterMs });
    }
    return error("http", said);
  }

  return {
    name,
    tier,
    model,
    async probe(limits: TranscribeOptions = {}): Promise<Probe> {
      try {
        // Any HTTP answer means the server runs; whisper-server has no /models.
        await call("/models", { method: "GET", headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} }, { timeoutMs: 3000, ...limits });
        state = { state: "ready" };
        return { ok: true, where: baseURL };
      } catch (caught) {
        const failed = caught as FoxvoiceError;
        if (failed.code === "http") return { ok: true, where: baseURL };
        state = { state: "unavailable", reason: failed.message };
        return { ok: false, code: failed.code, reason: failed.message, where: baseURL };
      }
    },
    status: () => ({ name, tier, model, where: baseURL, ...state }),
    async transcribe(audio: Float32Array, limits: TranscribeOptions): Promise<Transcription> {
      const form = new FormData();
      form.append("file", encodeWav(audio), "speech.wav");
      form.append("model", model);
      form.append("response_format", responseFormat);
      if (limits.language) form.append("language", limits.language);
      const response = await call("/audio/transcriptions", { method: "POST", body: form, headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} }, limits);
      if (!response.ok) throw await failure(response);
      let reply: { text?: unknown; segments?: { avg_logprob?: unknown }[] };
      try {
        reply = (await response.json()) as typeof reply;
      } catch (cause) {
        throw error("bad_response", `${name} did not answer with JSON.`, { cause });
      }
      if (typeof reply.text !== "string") throw error("bad_response", `${name} answered without a "text" field.`);
      const logprobs = (reply.segments ?? []).map((segment) => segment.avg_logprob).filter((value): value is number => typeof value === "number");
      const text = reply.text.replace(/\s+/g, " ").trim();
      return logprobs.length ? { text, confidence: logprobs.reduce((sum, value) => sum + Math.exp(value), 0) / logprobs.length } : { text };
    },
  };
}

/** whisper.cpp's whisper-server on this computer. Port 8178 keeps clear of llama-server on 8080. */
export function whisperServer(options: { port?: number; model?: string } = {}): SttProvider {
  const port = options.port ?? 8178;
  return transcriptionServer({
    baseURL: `http://127.0.0.1:${port}/v1`,
    model: options.model ?? "whisper-1",
    name: "whisper-server",
    startHint: `Start it with "whisper-server -m ggml-tiny.en.bin --port ${port} --inference-path /v1/audio/transcriptions".`,
  });
}
