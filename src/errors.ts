import type { Tier } from "foxmind";

/** Every way a foxvoice call can fail. docs/failure-modes.md says when each one comes. */
export type ErrorCode =
  // The microphone and the audio.
  | "unsupported" | "mic_denied" | "no_microphone" | "mic_busy" | "busy" | "too_short" | "too_long" | "no_speech" | "bad_audio"
  // Every call.
  | "aborted" | "timeout" | "bad_input"
  // Speech to text providers.
  | "no_provider" | "private_mode" | "unreachable" | "auth" | "model_not_found" | "rate_limited" | "http" | "insecure"
  | "bad_response" | "download_failed" | "out_of_memory" | "webgpu_missing"
  // Text to speech.
  | "no_voice" | "voice_not_local" | "tts_failed";

export interface ErrorDetails {
  provider?: string;
  tier?: Tier;
  /** For rate_limited: how long the server asks you to wait. */
  retryAfterMs?: number;
  cause?: unknown;
}

export class FoxvoiceError extends Error {
  readonly code: ErrorCode;
  readonly provider?: string;
  readonly tier?: Tier;
  readonly retryAfterMs?: number;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "FoxvoiceError";
    this.code = code;
    if (details.provider !== undefined) this.provider = details.provider;
    if (details.tier !== undefined) this.tier = details.tier;
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
  }
}
