# foxvoice

[![npm version](https://img.shields.io/npm/v/foxvoice)](https://www.npmjs.com/package/foxvoice)
[![Downloads/month](https://img.shields.io/npm/dm/foxvoice)](https://www.npmjs.com/package/foxvoice)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/foxvoice) · [Setup](#send-your-first-transcript) · [API](#runtime-surfaces) · [Comparisons](#compare)

foxvoice is an open-source speech interface for Firefox extension developers. It combines push-to-talk recording, speech recognition, and local text-to-speech. Provider routing allows browser and local speech by default.

## Install

```bash
npm install foxvoice @huggingface/transformers
```

Node.js 24 or newer is required for development. Speech runs in a browser page with microphone and speech APIs.
The package has one direct runtime dependency, foxmind, and an optional Transformers.js peer dependency.

## Send your first transcript

Bundle this code into a Firefox extension sidebar or popup with a `<button id="talk">Talk</button>` element.
Copy ONNX Runtime's `ort-wasm-simd-threaded.asyncify.mjs` and `.wasm` files from `onnxruntime-web/dist` into the extension's `ort/` directory.
Allow model downloads from Hugging Face in your extension policy. No environment variables or API keys are required.

```js
import { createVoice } from "foxvoice";
import { whisper } from "foxvoice/browser";

const voice = createVoice({ stt: [whisper()] });
const button = document.querySelector("#talk");
button.addEventListener("pointerdown", async () => {
  try {
    const heard = await voice.listen();
    console.log(heard.text, heard.provider, heard.tier);
    await voice.speak(`You said: ${heard.text}`);
  } catch (error) {
    console.error(error);
  }
});
button.addEventListener("pointerup", () => voice.stop());
button.addEventListener("pointercancel", () => voice.cancel());
```

Hold the button, grant microphone access, speak, then release it.
The first call downloads model files. Success prints your transcript with `whisper browser` and reads it aloud with an available local voice.

## How it works

```text
Microphone -> 16 kHz mono audio -> allowed speech provider -> transcript
                                                              |
Your application -> reply text -> local speech synthesis <-----+
```

`only` defaults to `["browser", "local"]`. Disallowed providers are never probed or called.
Model files still need an initial download; local inference does not mean an offline first installation.

## Why it exists

Firefox extension developers need recording, transcription, and speech playback in one interface.
annyang provides voice commands through browser speech recognition. Whisper Turbo provides browser Whisper inference.
foxvoice adds tier-based provider routing and microphone lifecycle controls around speech tasks.

## Compare

Scope checked on 2026-10-14 against [annyang](https://www.talater.com/annyang/) and [Whisper Turbo](https://github.com/FL33TW00D/whisper-turbo).

| Scope | foxvoice | annyang | Whisper Turbo |
|---|---|---|---|
| Main abstraction | Recording, provider routing, speech playback | Voice commands | Client-side Whisper inference |
| Recognition mechanism | Whisper or transcription server | Browser SpeechRecognition | Whisper |
| Configuration | JavaScript provider objects | JavaScript command map | Inference API |

## Coverage

| Integration | Status | Execution |
|---|---|---|
| Hugging Face Transformers.js / Whisper | ✓ implemented | Browser, WebAssembly or WebGPU |
| whisper.cpp whisper-server | ✓ implemented wrapper | Loopback HTTP server you run |
| OpenAI-compatible transcription API | ✓ implemented adapter | Local or cloud server you configure |
| Browser speech synthesis | ✓ implemented | Local voices by default |

The source exports three speech-provider factories: `whisper`, `whisperServer`, and `transcriptionServer`.
`whisperServer` wraps `transcriptionServer`; these are not three independent inference engines.
This rewrite checks source and local tests. It does not credential-check cloud services or rerun Firefox end-to-end tests.

## Common use cases

1. Firefox extension developers: add dictation with Transformers.js and Whisper.
2. Agent builders: pass transcripts to foxmind and speak model replies.
3. Local AI users: route speech to a self-hosted whisper.cpp server.
4. Accessibility developers: read interface text through Firefox speech synthesis.

## Features

- **Push to talk:** `listen`, `stop`, and `cancel` control recording.
- **Provider routing:** `only`, `prefer`, and `fallbackOnError` control selection.
- **Audio checks:** reject silence and recordings shorter than the configured minimum.
- **Progress:** provider status exposes model download progress.
- **Speech playback:** select voice, language, rate, pitch, and volume.

## Runtime surfaces

`foxvoice` exports `createVoice`, `openMic`, `speak`, `listVoices`, `transcriptionServer`, `whisperServer`, and `FoxvoiceError`.
Audio helpers are `SAMPLE_RATE`, `decodeAudio`, `encodeWav`, and `loudness`. TypeScript types are included.
`foxvoice/browser` exports `whisper` and its options type.

A voice exposes `listen`, `stop`, `cancel`, `transcribe`, `speak`, `on`, and `status`.
Events are `state`, `level`, `transcript`, and `error`.
There is no command-line interface or Model Context Protocol (MCP) server.

## Delivery and behavior limits

- Browser Whisper accepts at most 30 seconds per transcription. The default model is English-only `onnx-community/whisper-tiny.en`.
- Recording defaults to 30 seconds maximum, 300 milliseconds minimum, and a 0.01 silence threshold.
- Extension pages without cross-origin isolation use one WebAssembly thread.
- Cancellation stops waiting for inference; ONNX Runtime cannot stop an inference midway.
- Provider fallback after a transcription error defaults to off. There is no automatic HTTP retry loop.
- A server probe accepts any HTTP response as reachability. It does not prove authentication or transcription works.
- Cloud providers require `only` to include `"cloud"`. API keys belong in your application configuration, never committed files.
- Speech playback requires an available voice. Private mode rejects voices marked as remote unless you override speech options.

## Integration guides

For whisper.cpp, run a server with a downloaded model:

```bash
whisper-server -m ggml-tiny.en.bin --port 8178 --inference-path /v1/audio/transcriptions
```

Use `createVoice({ stt: [whisperServer()] })` after importing `whisperServer` from `foxvoice`.
For other servers, pass `baseURL`, `model`, and an optional `apiKey` to `transcriptionServer`.
There is no separate public documentation site; setup and API guidance are included here.

## Status

Version 0.1.2 is an early release. APIs can change before 1.0.
Public case studies are not yet published. Report problems through the repository issue tracker if you have access.

### Development and demo extension

```bash
pnpm install
pnpm ci:local
pnpm build:ext
```

Load `dist-ext/manifest.json` through Firefox `about:debugging`.
The demo sidebar sends transcripts to a local model server through foxmind, then speaks the reply.
The default model server uses port 8080. Configure another server in Settings.
`pnpm e2e` runs the Firefox extension checks with recorded audio; it needs a Firefox installation.
`ci:local` runs lint, type checks, unit tests, package and extension builds, extension lint, and add-on listing checks.

## FAQ

### Which integrations are verified?

foxvoice includes implementations for browser Whisper, whisper.cpp, compatible transcription servers, and browser speech synthesis. Local tests cover simulated media and HTTP servers; cloud credentials were not tested for this rewrite.

### Does foxvoice provide a managed speech service?

foxvoice provides a library. You run local servers or configure a cloud service with your own credentials.

### How is foxvoice different from annyang?

foxvoice routes audio to explicit providers and controls recording and playback. [annyang](https://www.talater.com/annyang/) focuses on commands through browser speech recognition.

### How is foxvoice different from Whisper Turbo?

foxvoice includes microphone controls, provider routing, and speech playback. [Whisper Turbo](https://github.com/FL33TW00D/whisper-turbo) focuses on client-side Whisper inference.

### Does foxvoice send audio to the cloud?

foxvoice allows browser and local providers by default. Cloud transcription requires an explicit tier opt-in; browser models still download from a model hub.

### Can foxvoice run without a microphone?

foxvoice accepts 16 kHz mono `Float32Array` samples through `transcribe`. It also accepts a browser-decodable `Blob`.

### Does foxvoice support other languages?

foxvoice can load a multilingual Whisper model and accept a language code. The default English-only model rejects other language codes.

### Does foxvoice retry failed requests?

foxvoice does not automatically retry HTTP requests. Optional provider fallback can try another provider after eligible errors.

## License

MIT.
