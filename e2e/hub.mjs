// A local copy of huggingface.co for the E2E test. It keeps each file on
// disk after the first download, adds CORS headers, counts requests, and
// can cut one model file in half, so the test sees a real broken download.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const CACHE = "node_modules/.cache/foxvoice-hub";

export async function startHub() {
  const state = { cut: false, requests: [] };
  mkdirSync(CACHE, { recursive: true });
  const server = createServer(async (req, res) => {
    const path = req.url ?? "/";
    state.requests.push(path);
    const cors = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
    if (req.method === "OPTIONS") return res.writeHead(204, { ...cors, "access-control-allow-headers": "*" }).end();
    try {
      const file = join(CACHE, createHash("sha256").update(path).digest("hex"));
      if (!existsSync(file)) {
        const upstream = await fetch(`https://huggingface.co${path}`, { redirect: "follow" });
        if (!upstream.ok) return res.writeHead(upstream.status, cors).end(await upstream.text());
        writeFileSync(file, Buffer.from(await upstream.arrayBuffer()));
      }
      const body = readFileSync(file);
      const headers = { ...cors, "content-type": "application/octet-stream", "content-length": String(body.length) };
      if (state.cut && path.endsWith(".onnx")) {
        state.cut = false;
        res.writeHead(200, headers);
        res.write(body.subarray(0, body.length >> 1));
        setTimeout(() => res.destroy(), 50);
        return;
      }
      res.writeHead(200, headers).end(body);
    } catch (error) {
      res.writeHead(502, cors).end(String(error));
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    state,
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

/** Word error rate: word edits (insert, delete, change) over the words in the reference. */
export function wordErrorRate(reference, heard) {
  const words = (text) => text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  const ref = words(reference);
  const hyp = words(heard);
  let previous = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const row = [i];
    for (let j = 1; j <= hyp.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[hyp.length] / ref.length;
}
