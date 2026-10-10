export { FoxvoiceError, type ErrorCode, type ErrorDetails } from "./errors.js";
export { SAMPLE_RATE, decodeAudio, encodeWav, loudness } from "./audio.js";
export { openMic, type MediaHooks, type Mic, type MicOptions, type Recording, type StopReason } from "./mic.js";
export { transcriptionServer, whisperServer, type TranscriptionServerOptions } from "./server.js";
export type { Probe, SttProvider, SttStatus, Tier, TranscribeOptions, Transcription } from "./types.js";
export { listVoices, speak, type SpeakOptions, type Spoken } from "./speak.js";
