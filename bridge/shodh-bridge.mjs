#!/usr/bin/env node
// Standalone adapter between Marinara Engine's webhook Custom Tools and shodh-memory's
// REST API (https://github.com/varun29ankuS/shodh-memory). Run this next to a running
// shodh-memory server (`shodh server`, default http://localhost:3030).
//
// Marinara's webhook tool type always POSTs `{ tool: "<name>", arguments: {...} }` with
// only a Content-Type header (no custom auth headers, no body reshaping). This bridge
// unwraps that envelope, maps fields onto shodh's expected body, injects X-API-Key, and
// forwards to shodh's real REST endpoints. shodh's exact wire format below (user_id /
// content / memory_type / query / limit) is taken from its README's curl examples --
// adjust the mapping here if the live API differs.
//
// The three tools have includeHiddenContext enabled, so Marinara also sends a top-level
// `context` field carrying the current character's id/name -- computed by Marinara itself,
// not decided by the calling LLM. The bridge reads user_id from context.characterId, only
// falling back to arguments.characterId (useful for manual curl testing of the bridge).
//
// This is not a Marinara Engine code change: it's a separate process the user runs
// alongside shodh. Configure via bridge/.env (copy from .env.example) or real env vars.

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
loadDotEnv(join(here, ".env"));

const PORT = Number(process.env.BRIDGE_PORT || 8135);
const SHODH_BASE_URL = (process.env.SHODH_BASE_URL || "http://localhost:3030").replace(/\/+$/, "");
const SHODH_API_KEY = process.env.SHODH_API_KEY || "";
const DEBUG = /^(1|true|yes)$/i.test(process.env.SHODH_BRIDGE_DEBUG || "");

if (!SHODH_API_KEY) {
  console.error(
    "SHODH_API_KEY is not set. Copy bridge/.env.example to bridge/.env and fill it in, or export SHODH_API_KEY before starting.",
  );
  process.exit(1);
}

let requestCounter = 0;

async function callShodh(path, body) {
  const reqId = ++requestCounter;
  const url = `${SHODH_BASE_URL}${path}`;
  if (DEBUG) console.log(`[shodh-bridge] #${reqId} -> POST ${url} ${JSON.stringify(body)}`);

  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": SHODH_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    if (DEBUG) console.log(`[shodh-bridge] #${reqId} <- connection failed after ${Date.now() - startedAt}ms: ${message}`);
    return { error: `Could not reach shodh at ${url}: ${message}` };
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (DEBUG) console.log(`[shodh-bridge] #${reqId} <- ${res.status} in ${Date.now() - startedAt}ms`);
  if (!res.ok) return { error: `shodh ${path} failed (${res.status})`, detail: json };
  return json;
}

async function handleTool(name, args, context) {
  const characterId = String(context?.characterId ?? args.characterId ?? "").trim();
  if (!characterId) {
    return {
      error:
        "characterId is required -- expected in hidden context (enable includeHiddenContext on this tool), or as a characterId argument as a fallback",
    };
  }

  switch (name) {
    case "shodh_remember":
      return callShodh("/api/remember", {
        user_id: characterId,
        content: String(args.content ?? ""),
        memory_type: args.memoryType ? String(args.memoryType) : "fact",
        ...(Array.isArray(args.tags) ? { tags: args.tags } : {}),
      });

    case "shodh_recall":
      return callShodh("/api/recall", {
        user_id: characterId,
        query: String(args.query ?? ""),
        limit: typeof args.limit === "number" ? args.limit : 5,
      });

    case "shodh_reinforce":
      // shodh has no dedicated "strengthen" endpoint -- recalling a memory is what
      // triggers its own automatic Hebbian strengthening per its docs, so reinforcement
      // is implemented as a targeted, tightly-scoped recall against the existing fact.
      return callShodh("/api/recall", {
        user_id: characterId,
        query: String(args.content ?? ""),
        limit: 1,
      });

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "POST only" }));
    return;
  }

  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", async () => {
    try {
      const payload = JSON.parse(raw || "{}");
      const result = await handleTool(String(payload.tool ?? ""), payload.arguments ?? {}, payload.context ?? null);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } catch (err) {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: err instanceof Error ? err.message : "bridge error" }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`shodh bridge listening on http://localhost:${PORT}, forwarding to ${SHODH_BASE_URL}`);
});
