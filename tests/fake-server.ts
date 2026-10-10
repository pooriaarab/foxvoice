// A fake transcription server on 127.0.0.1 that answers each request with
// the reply the test sets, and records what it got.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface Got {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export async function fakeServer(reply: (got: Got, res: ServerResponse) => void) {
  const got: Got[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const one = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("latin1") };
      got.push(one);
      reply(one, res);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/v1`,
    got,
    close: () => new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    }),
  };
}

export const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
