// Failure modes S1-S10 (docs/failure-modes.md), against a fake server over real HTTP.
import { afterEach, describe, expect, it } from "vitest";
import { FoxvoiceError, transcriptionServer, whisperServer } from "../src/index.js";
import { fakeServer, json } from "./fake-server.js";
import { tone } from "./fake-media.js";

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
async function serve(reply: Parameters<typeof fakeServer>[0]) {
  const server = await fakeServer(reply);
  servers.push(server);
  return server;
}
const audio = tone(1000);
const fail = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FoxvoiceError);
    return error as FoxvoiceError;
  }
  throw new Error("expected a FoxvoiceError");
};

describe("transcription server", () => {
  it("posts a 16 kHz WAV file and reads text and confidence from verbose_json (S10)", async () => {
    const server = await serve((_, res) => json(res, 200, { text: " Open my mail. ", segments: [{ avg_logprob: Math.log(0.9) }, { avg_logprob: Math.log(0.7) }] }));
    const provider = transcriptionServer({ baseURL: server.url, model: "whisper-1" });
    const result = await provider.transcribe(audio, { language: "en" });
    expect(result.text).toBe("Open my mail.");
    expect(result.confidence).toBeCloseTo(0.8);
    const [got] = server.got;
    expect(got?.method).toBe("POST");
    expect(got?.path).toBe("/v1/audio/transcriptions");
    expect(got?.body).toContain("RIFF");
    expect(got?.body).toContain('name="response_format"\r\n\r\nverbose_json');
    expect(got?.body).toContain('name="language"\r\n\r\nen');
  });

  it("S10: no log probabilities leaves confidence undefined", async () => {
    const server = await serve((_, res) => json(res, 200, { text: "hello" }));
    const result = await transcriptionServer({ baseURL: server.url }).transcribe(audio, {});
    expect(result).toEqual({ text: "hello" });
  });

  it("S1: a server that is down fails the probe with unreachable and the start command", async () => {
    const provider = whisperServer({ port: 9 });
    const probe = await provider.probe();
    expect(probe.ok).toBe(false);
    expect(probe.code).toBe("unreachable");
    expect(probe.reason).toMatch(/whisper-server .*--inference-path \/v1\/audio\/transcriptions/);
    expect((await fail(provider.transcribe(audio, {}))).code).toBe("unreachable");
  });

  it("S1: a server that runs passes the probe", async () => {
    const server = await serve((_, res) => res.writeHead(404).end());
    expect(await transcriptionServer({ baseURL: server.url }).probe()).toMatchObject({ ok: true, where: server.url });
  });

  it.each([401, 403])("S2: status %i gives auth, and the key is in no message", async (status) => {
    const server = await serve((_, res) => json(res, status, { error: { message: "bad key sk-secret-123" } }));
    const error = await fail(transcriptionServer({ baseURL: server.url, apiKey: "sk-secret-123" }).transcribe(audio, {}));
    expect(error.code).toBe("auth");
    expect(error.message).not.toContain("sk-secret-123");
    expect(server.got[0]?.headers.authorization).toBe("Bearer sk-secret-123");
  });

  it("S3: 404 gives model_not_found", async () => {
    const server = await serve((_, res) => json(res, 404, { error: { message: "no such model" } }));
    expect((await fail(transcriptionServer({ baseURL: server.url, model: "nope" }).transcribe(audio, {}))).code).toBe("model_not_found");
  });

  it("S4: 429 gives rate_limited with retryAfterMs", async () => {
    const server = await serve((_, res) => json(res, 429, {}, { "retry-after": "7" }));
    const error = await fail(transcriptionServer({ baseURL: server.url }).transcribe(audio, {}));
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterMs).toBe(7000);
  });

  it.each([
    ["not JSON", (res: Parameters<typeof json>[0]) => res.writeHead(200, { "content-type": "text/plain" }).end("hello")],
    ["no text", (res: Parameters<typeof json>[0]) => json(res, 200, { segments: [] })],
  ])("S5: a reply with %s gives bad_response", async (_, reply) => {
    const server = await serve((__, res) => reply(res));
    expect((await fail(transcriptionServer({ baseURL: server.url }).transcribe(audio, {}))).code).toBe("bad_response");
  });

  it("S6: no answer in time gives timeout", async () => {
    const server = await serve(() => {});
    expect((await fail(transcriptionServer({ baseURL: server.url }).transcribe(audio, { timeoutMs: 200 }))).code).toBe("timeout");
  });

  it("S6: the caller's abort gives aborted", async () => {
    const server = await serve(() => {});
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    expect((await fail(transcriptionServer({ baseURL: server.url }).transcribe(audio, { signal: controller.signal }))).code).toBe("aborted");
  });

  it("S7: the tier comes from the URL; an option can make it stricter, never looser", () => {
    expect(transcriptionServer({ baseURL: "http://127.0.0.1:8178/v1" }).tier).toBe("local");
    expect(transcriptionServer({ baseURL: "http://localhost:8178/v1" }).tier).toBe("local");
    expect(transcriptionServer({ baseURL: "http://[::1]:8178/v1" }).tier).toBe("local");
    expect(transcriptionServer({ baseURL: "http://127.0.0.1:8178/v1", tier: "cloud" }).tier).toBe("cloud");
    expect(transcriptionServer({ baseURL: "https://api.openai.com/v1", apiKey: "k", tier: "local" as "cloud" }).tier).toBe("cloud");
    expect(transcriptionServer({ baseURL: "http://192.168.1.5:8178/v1" }).tier).toBe("cloud");
  });

  it("S8: a redirect to another host is refused and the audio is not sent there", async () => {
    const target = await serve((_, res) => json(res, 200, { text: "stolen" }));
    const server = await serve((_, res) => res.writeHead(307, { location: `${target.url}/audio/transcriptions` }).end());
    expect((await fail(transcriptionServer({ baseURL: server.url }).transcribe(audio, {}))).code).toBe("http");
    expect(target.got).toHaveLength(0);
  });

  it("S9: a key over plain http to another computer is refused before any request", () => {
    expect(() => transcriptionServer({ baseURL: "http://example.com/v1", apiKey: "sk-1" })).toThrow(expect.objectContaining({ code: "insecure" }));
    expect(() => transcriptionServer({ baseURL: "http://127.0.0.1:8178/v1", apiKey: "sk-1" })).not.toThrow();
  });
});
