# Shodh Memory for Marinara Engine

Gives every AI character its own persistent, per-character memory, backed by
[shodh-memory](https://github.com/varun29ankuS/shodh-memory) (an offline memory
service -- no LLM calls to store/retrieve, local embeddings + a typed knowledge graph).

Two agents:

* **Shodh Memory Recall** (`pre_generation`) -- before {{char}} replies, searches shodh
for relevant memories and injects them into context. Runs every turn.
* **Shodh Memory Writer** (`post_processing`) -- stores new memories or reinforces
existing ones. Ships with `settings.runInterval: 5` and `settings.contextSize: 5`, so
by default it only runs once every 5 user messages and reads the last 5 messages of
history when deciding what to store (both are Marinara's own built-in agent-cadence
and context-window settings -- `runInterval` in
`packages/server/src/routes/generate.routes.ts`, `contextSize` in
`packages/server/src/services/agents/agent-executor.ts` -- not something the bridge or
prompt enforces). Adjust or remove either field in the imported agent's settings to
change the cadence/window.

These are delivered as **pure JSON**, importable through Marinara's existing Agents
and Functions import UI. No source code, no rebuild, no registry regeneration.

## Why there's a "bridge" script

Marinara's webhook-type custom tools always POST `{ "tool": "<name>", "arguments": {...} }`
with only a `Content-Type: application/json` header -- there's no way to add shodh's
`X-API-Key` header or reshape the body to match shodh's expected
`{user_id, content, memory_type}` / `{user_id, query, limit}` fields purely through the
webhook config. The sandboxed "script" tool type was also checked and has no network
access at all (bare Node `vm` context, no `fetch`).

So `bridge/shodh-bridge.mjs` is a tiny, zero-dependency Node script that sits between
the two: Marinara's webhook tools point at it, it unwraps the payload, adds the API key,
reshapes the fields, and forwards to shodh's real REST API. It's not a Marinara code
change -- just a small process you run alongside shodh.

```
Marinara (imported agents + webhook tools) -> bridge/shodh-bridge.mjs -> shodh-memory REST API
```

## Setup

1. **Install and run shodh-memory** (see its README): `shodh init` (generates an API
key), then `shodh server` (defaults to `http://localhost:3030`).
2. **Configure and run the bridge**:

```
   cd result/bridge
   cp .env.example .env
   # edit .env: set SHODH_API_KEY to the key from `shodh init`
   node shodh-bridge.mjs
   ```

   Leave it running. It listens on `http://localhost:8135` by default and forwards to
`SHODH_BASE_URL`. Set `SHODH_BRIDGE_DEBUG=true` in `.env` to log every outbound
request to shodh (URL, body, and response status/timing or connection failure) --
handy when diagnosing why memories aren't showing up.

3. **Import the tools**: in Marinara, open the Presets panel -> Functions section ->
"Import functions from ZIP or JSON" -> select `result/functions/marinara-functions.json`.
This creates `shodh_remember`, `shodh_recall`, and `shodh_reinforce`.
4. **Import the agents**: open the Agents panel -> "Import agents" -> select
`result/agents/marinara-agents.json`. This creates "Shodh Memory Recall" and
"Shodh Memory Writer".
5. **Assign a connection**: import can't set which LLM connection an agent uses
(`connectionId` comes in `null`). Open each imported agent and pick a connection/model.
6. **Enable the agents** for whichever chats/characters you want memory on.

If your bridge runs on a different port, or shodh runs on a different host, update the
`webhookUrl` in the three imported tools (or in `functions/marinara-functions.json`
before importing) to match, and update `bridge/.env` accordingly.

### Allow the webhook to reach localhost

Marinara's webhook custom tools are HTTPS-only and block localhost/private IPs by
default (`packages/server/src/services/tools/tool-executor.ts`). Since the bridge runs
locally over plain HTTP, add this to **Marinara's own server `.env`** (not the bridge's):

```
WEBHOOK_LOCAL_URLS_ENABLED=true
```

This takes effect within \~2s, no server restart needed. Without it, calling any of the
three tools fails with `Refused to fetch http://...: protocol 'http' is not allowed`.

## Character-as-user mapping

shodh's `user_id` = the AI character's id (a UUID), **not** the human. Each character
therefore accrues its own independent memory bank -- Character A and Character B never
see each other's memories, even in the same chat.

The character id is **not decided by the LLM**. All three tools have
`includeHiddenContext: true`, which makes Marinara itself attach a `context` object to
every tool call (`buildCustomToolHiddenContext` in
`packages/server/src/services/generation/tool-resolution-runtime.ts`) containing the
current `characterId`/`characterName`, computed server-side from the actual chat state.
The bridge reads `context.characterId` for `user_id` and never asks the model to supply
one -- the agent prompts don't even mention `characterId` as a tool argument. (A
`characterId` argument is still accepted as a manual fallback, mainly so you can curl the
bridge directly without going through Marinara at all.)

## Reinforcement

shodh-memory has no dedicated "strengthen" endpoint -- per its own docs, recalling a
memory is what triggers its automatic Hebbian strengthening. So `shodh_reinforce` is
implemented as a targeted recall against the existing fact's content. The writer agent's
prompt tells it to call `shodh_reinforce` (not `shodh_remember`) when a fact is being
reaffirmed rather than learned for the first time, to avoid piling up duplicate memories.

