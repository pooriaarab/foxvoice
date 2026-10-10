# Failure modes

This file lists every way foxvoice can fail that we know of. Each row says what
foxvoice does then, and which test checks it. We wrote this list first, then
the tests, then the code.

`E2E` means a check in `e2e/run.mjs` that runs in a real Firefox. The test
gives the microphone a known WAV file (`e2e/extension/jfk.wav`) in place of a
real microphone. `unit` means a test in `tests/` that runs in Node with a fake
microphone, a fake speech engine or a fake server. We use a unit test only when
an E2E check cannot reach the failure.

Words used here:

- **Push to talk**: the microphone is on only while the user holds the button.
- **Private mode**: the default. Only the `browser` and `local` tiers can run,
  so audio and text never leave the computer.
- **Tier**: where speech to text runs: `browser` (in the extension page),
  `local` (a server on this computer) or `cloud` (a server you pay with your
  own key). These are the same tiers as in foxmind.

## Microphone and recording (M)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| M1 | The page has no `navigator.mediaDevices` or no `MediaRecorder` (a background page, Node). | `listen()` throws `FoxvoiceError` with code `unsupported`. It does not ask for the microphone. | unit |
| M2 | The user says no to the microphone prompt (`NotAllowedError`, `SecurityError`). | Throw code `mic_denied`. The message says how to allow the microphone again. | unit |
| M3 | The computer has no microphone (`NotFoundError`, `OverconstrainedError`). | Throw code `no_microphone`. | unit |
| M4 | Another app holds the microphone, or the hardware fails (`NotReadableError`, `AbortError`). | Throw code `mic_busy`. | unit |
| M5 | The microphone stays on after the user lets go, after `cancel()` or after an error. | Every exit path stops every track of the stream. | E2E: track `readyState` is `ended` after stop, cancel and the time limit; unit: after each error |
| M6 | `listen()` is called while a session runs. | Throw code `busy`. The first session goes on. | unit |
| M7 | The user holds the button past the time limit (`maxMs`, default 30 s). | Stop at `maxMs`, transcribe what was said, and set `stoppedBy: "limit"`. | E2E |
| M8 | The user lets go before there is audio, or after less than `minMs` (default 300 ms). | Throw code `too_short`. Do not call a model. | unit |
| M9 | The audio is silence. | Throw code `no_speech`. Do not call a model. | unit |
| M10 | `cancel()` while the microphone is on. | `listen()` rejects with code `aborted`. No `transcript` event. The microphone goes off. | E2E |
| M11 | The caller's `AbortSignal` aborts. | Same as M10. | unit |
| M12 | The recorded audio does not decode. | Throw code `bad_audio`. | E2E: transcribe a Blob that is not audio |
| M13 | The audio is not 16 kHz mono (a microphone gives 48 kHz). | Resample to 16 kHz mono before the model. | E2E: 11 s of audio gives 11 s at 16 kHz |
| M14 | The track ends by itself while the microphone is on (the device is unplugged). | Stop, transcribe what came before, and set `stoppedBy: "device"`. | unit |

## Choosing the speech to text provider (R)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| R1 | The provider list has a cloud provider, and the caller did not opt in to the cloud tier. | Never probe or call it. Add it to `skipped` with code `private_mode`. | unit: the fake cloud server gets 0 requests; E2E: same with a trap server |
| R2 | No provider can run. | Throw code `no_provider`. The message lists each provider and why it was skipped. | unit |
| R3 | A provider cannot run now (server down). | Skip it, use the next one, and list the skip in `transcript.skipped`. | unit |
| R4 | A provider fails during the call. | Throw that error. Try the next provider only with `fallbackOnError: true`. | unit |
| R5 | The caller sets `prefer`. | Try providers in that order. `prefer` never lets a tier run that `only` drops. | unit |

## Whisper in the browser (W)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| W1 | The model hub cannot be reached, or the download stops. | Throw code `download_failed`. The next call downloads again. | E2E: hub on a closed port |
| W2 | The model is not on the hub. | Throw code `model_not_found`. | E2E |
| W3 | Two calls come while the model loads. | Load the model once. Both calls get a transcript. | E2E |
| W4 | The extension page has no `SharedArrayBuffer`, so WASM has no threads. | Run ONNX Runtime on one WASM thread. | E2E: `crossOriginIsolated` is false and the transcript is right |
| W5 | The caller asks for WebGPU and there is none (Linux, Intel Macs, headless). | Throw code `webgpu_missing` before the download. | E2E (headless has no WebGPU) |
| W6 | The audio is longer than 30 s, the Whisper window. | Throw code `too_long`. Never cut the audio without a word. | E2E |
| W7 | Whisper makes up words from noise. | Return a low `confidence` (under 0.5), so the caller can ask again. | E2E: noise gives confidence under 0.5, speech over 0.8 |
| W8 | The transcript gets worse after a change. | The E2E test measures the word error rate on `jfk.wav` and fails above 10 %. | E2E |
| W9 | The caller asks an English-only model (`*.en`) for another language. | Throw code `unsupported` before the download. | unit |
| W10 | The device runs out of memory. | Throw code `out_of_memory` (mapped from the runtime's error text, as foxmind does). | not tested: we cannot cause it on purpose |

## Speech to text on a server (S)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| S1 | The server is down. | The probe fails with code `unreachable` and the command that starts it. | unit |
| S2 | The key is wrong (401, 403). | Throw code `auth`. The key is never in an error message. | unit |
| S3 | The model is not on the server (404). | Throw code `model_not_found`. | unit |
| S4 | Too many requests (429). | Throw code `rate_limited` with `retryAfterMs` from `Retry-After`. | unit |
| S5 | The reply is not JSON, or has no `text`. | Throw code `bad_response`. | unit |
| S6 | The server does not answer in time, or the caller aborts. | Throw code `timeout` or `aborted`. | unit |
| S7 | A server that is not on this computer says it is `local`. | The tier comes from the URL: only `localhost`, `127.0.0.1` and `[::1]` are `local`. A `tier` option can make a provider stricter, never looser. | unit |
| S8 | The server redirects to another host, which would send the audio there. | Refuse the redirect. Throw code `http`. | unit |
| S9 | A key would go over plain `http:` to another computer. | Refuse with code `insecure` before the request. | unit |
| S10 | The server gives no confidence. | Leave `confidence` undefined. Never make one up. When `verbose_json` has `avg_logprob`, use it. | unit |

## Text to speech (T)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| T1 | The page has no `speechSynthesis`. | `speak()` throws code `unsupported`. | unit |
| T2 | Firefox gives an empty voice list at first and fills it later. | Wait for `voiceschanged` up to 2 s, then throw code `no_voice`. | unit; E2E: the first `speak()` in a fresh page works |
| T3 | In private mode the chosen voice is not on the device (`localService` is false). | Throw code `voice_not_local`. Do not speak. Without a chosen voice, pick a local one. | unit |
| T4 | The speech engine reports an error. | Throw code `tts_failed` with the engine's error name. | unit |
| T5 | `cancel()` while it speaks. | Stop the speech. `speak()` rejects with code `aborted`. | unit; E2E |
| T6 | The text is empty. | Throw code `bad_input`. | unit |
| T7 | The engine never sends `end`. | Throw code `timeout` after a time that grows with the text length. | unit |
| T8 | `listen()` while it speaks: the microphone would hear the reply. | Stop the speech first, then start the microphone. | E2E |
| T9 | After `cancel()` during speech, Firefox keeps the page's speech queue stuck: `speaking` stays true and later utterances never start (seen in Firefox 157 on macOS; see [bug 1522074](https://bugzilla.mozilla.org/show_bug.cgi?id=1522074)). | Speak each text in its own hidden iframe, which has its own speech queue, and remove the iframe at the end. | E2E: `speak()` after a cancel ends |

## Demo extension (D)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| D1 | The sidebar cannot show the microphone prompt. | The panel shows a button that opens a setup page in a tab. That page asks once; the sidebar then has the permission. | E2E: the setup page reports the result; headed check by hand |
| D2 | The pointer leaves the button, or the window loses focus, while the user holds it. | Stop the microphone, as if the user let go. | E2E |
| D3 | No local model server runs. | The reply says so plainly and repeats what it heard. It names who answered. | E2E |
| D4 | A local model server runs. | foxmind sends the transcript to it, and the panel speaks the reply. | E2E with a fake llama-server |
| D5 | The user holds Space on the button. | Space works as push to talk. | E2E |

## The E2E test itself (H)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| H1 | The machine has no audio output device (a Linux CI runner). Firefox's AudioContext stays suspended and `resume()` never settles, so a WAV microphone built on it never plays and the page call waits for ever. | The WAV microphone captures an `<audio>` element (`mozCaptureStream`), which plays on a system clock without a device. | E2E in a Linux container with no sound server |
| H2 | A page call in the E2E test does not settle. | The call fails within its own time limit, with the name of the call, not with Puppeteer's protocol timeout. | E2E |
| H3 | A check needs something this machine does not have (speech voices, `whisper-server`). | Skip the check with a `SKIP <check>: <reason>` log line, also in the artifact. Never hang. | E2E on Linux |
