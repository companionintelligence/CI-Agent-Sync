# Local coding pool and Companion Memory

Goal: code locally with the models served by the fleet, through Companion Hub,
with Companion Memory available to the same agents. This page records what
works, what does not, and what needs a decision.

## Route

`integrations/providers/routing.yaml` declares a `hub_pool` route. Its endpoint
is the Hub's OpenAI-compatible surface, `${COMPANION_HUB_BASE_URL}/api/inference/v1`,
and its key is `COMPANION_HUB_INFERENCE_API_KEY` from
`agent-configs-companion-hub-inference`. The route is used by `opencode`,
`codex`, `aider-desk` and `pi`, ahead of their local and gateway routes.

Launch a client with the key injected from 1Password:

```sh
COMPANION_HUB_BASE_URL=http://beta-max:5002 \
  ./bin/agent-store with companion-hub-inference -- opencode
```

### Model names and request shape (verified 2026-11-12)

- **Name the model by its Ollama tag, not its catalog id.** `qwen3.5:4b` is served
  (HTTP 200, `served` in the routing log). `qwen3-5-4b` is a catalog id, and the
  pool answers 502 "No pool node currently has model … available" for it. The
  catalog ids on `/api/inference/v1/models` are not routing names.
- **Qwen 3.5 is a reasoning model.** Without a switch it spends the whole
  `max_tokens` budget on reasoning and returns empty `content`. Send
  `"reasoning_effort": "none"`. `"think": false` did not stop it. A
  one-line coding probe with that switch returned `` `lambda n: 2 * n` `` in 10
  tokens.

```sh
curl -s http://beta-max:5002/api/inference/v1/chat/completions \
  -H "Authorization: Bearer $COMPANION_HUB_INFERENCE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3.5:4b","reasoning_effort":"none","max_tokens":200,
       "messages":[{"role":"user","content":"Write a one-line Python lambda that doubles n. Code only."}]}'
```

### Pin (applied 2026-11-12)

`cihub pool pin beta-1.capybara-ulmer.ts.net --model qwen3.5:4b --yes`, run on
`beta-max`. A pin is a preference. It reorders candidates and never forces a
route, so when beta-1 cannot serve, the request goes to the next node. Undo with
`cihub pool unpin --model qwen3.5:4b --yes`. The routing log marks pinned
decisions as `pinned (this model → peer)`.

## Status on 2026-11-12 (read-only checks)

| Check | Result |
| --- | --- |
| Hub liveness `/api/health/live` | 200 on 11 of 12 nodes. `beta-glass` is down (000) while its Ollama answers |
| Pool identity `/api/inference/pool/identify` | `poolProtocol: 2` on all 11 live Hubs |
| Inference catalog `/api/inference/v1/models` | About 235–244 entries per Hub, mostly catalog rows; not every entry is local |
| Ollama `/api/tags` | Reachable on 12 nodes. Per node: 3 to 12 tags, including `qwen3.5:4b` and `gemma3:1b` |
| Authenticated chat with the catalog id `qwen3-5-4b` | 502 "no pool node has model" — the id is wrong, not the pool |
| Authenticated chat with the Ollama tag `qwen3.5:4b` | **200, served by beta-1** after the pin; earlier served by core-14. Needs `reasoning_effort: none` to return content |

The earlier 502s were a naming mistake. The first diagnosis, that the Hub had no
loaded model, was wrong. Pinning was not what fixed it. The pin only makes the
routing deterministic.

### Model inventory on the pool (`cihub pool peers`, read-only)

`qwen3.5:4b` is on disk on core-14, core-6, beta-nas, beta-1 and beta-glass (the
last is unreachable). Coder models are also on several nodes: `qwen3-coder:30b`
on five nodes, `qwen2.5-coder:7b` on beta-red and beta-nas.

## Capacity (measured 2026-11-12)

Each node ran a 160-token coding prompt on its coder model.

| Node | Hardware | Runner · context × slots | Coder model · tok/s |
| --- | --- | --- | --- |
| beta-max, core-3, core-4, core-6, core-14, core-17 | Strix Halo class, about 122 GB | Vulkan · 262144 × 2 | qwen3-coder:30b · 82–85 |
| beta-1 | RX 7900 XTX, 24 GB | ROCm · 65536 × 1 | qwen3-coder:30b · 97 |
| beta-ms-a2 | Granite Ridge APU, 89 GB RAM | CPU only (`OLLAMA_IGPU_ENABLE=0`) · 262144 × 2 | qwen3-coder:30b · 26 (was 11 on the iGPU) |
| beta-red | RTX 3080, 10 GB | CUDA · env 65536, coder capped at its trained 32768 · 2 | qwen2.5-coder:7b · 126 |
| beta-nas | RTX A1000, 8 GB | CUDA · 32768 × 2 | qwen2.5-coder:7b · 36 |
| beta-glass | RTX 3070, 8 GB | CUDA · 32768 × 2 | qwen3.5:4b · 1.5 while the MetaHuman demo holds the GPU |

## Exposure (tailnet only, set up 2026-11-12)

Before the change, each pool node's Cloudflare tunnel published its Hub API on
port 5002 under `hub-<node>-demopool1.ci0.pw`, past Traefik's forward-auth. core-17
also published ComfyUI on port 8188 on every interface. The pool chat route
answered without a key (HTTP 200).

Now:

- **Nodes.** `tailnet-only-publish.service` (`/usr/local/sbin/tailnet-only-publish.sh`)
  hooks `DOCKER-USER`. NEW connections that arrive on a physical NIC are dropped
  unless their source is `100.64.0.0/10` (or `fd7a:115c:a1e0::/48` for IPv6). It
  also drops the Cloudflare connector at `10.128.0.3`, which cuts the tunnel origin.
  Public hostnames answer 530. LAN requests to port 5002 and the Traefik dashboard
  time out, and the tailnet still reaches port 5002 on every node.
- **Laptop.** `docker-compose.tailnet-only.yml` (repo root) binds the Hub API,
  Traefik, the Hub database and the queue to `127.0.0.1`. The Hub API is published
  to the tailnet with `tailscale serve` at `https://liambook.capybara-ulmer.ts.net`,
  and SearXNG at `:8443`. The previous SearXNG container is kept stopped as
  `companion-studio-searxng-old`.

The Portal still owns each device's tunnel. The Hub restores its tunnel token from
the Portal registration and recreates `cloudflared` when it starts or validates,
so deleting the token locally does not last. The guard keeps the hostnames dark.
To stop the connectors for good, disable each device's tunnel in the Portal (CI-Cloud).

## Companion Memory

No Companion Memory API answered on the tested fleet paths (`:3030`, `:8080`,
`https://<node>/api/health`). On the laptop, `agentctl companion status` reports
that no CI-Server is listening on `localhost:3030` because Docker is not
running. The fleet nodes run `ci-memory` containers, but their API route is not
recorded in this repository.

To connect agents to Memory, set `COMPANION_MEMORY_BASE_URL` to the
appliance's Caddy/gateway origin and keep the `companion-memory` key in
1Password. Then run:

```sh
./bin/agentctl companion memory status
```

## Open decisions

1. Anonymous chat completions on the Hub. The owner chose on 2026-11-12 to leave
   the route open, with the tailnet as the boundary. Revisit before the tailnet
   gains members outside the owner's control, or before any use beyond it.
2. Disable each device's tunnel in the Portal (CI-Cloud). The guard keeps the
   hostnames dark, but the Hub keeps the connector configured until the Portal
   stops issuing its token.
3. The laptop's loopback override (`docker-compose.tailnet-only.yml`) is not part
   of the Hub's own compose invocations. A Hub-driven recreate of `ci-hub` would
   publish port 5002 on every interface again. Move the binding into the Hub's
   compose template.
4. Which node serves Companion Memory, and its base URL.
5. Whether to pin a coder model too (`qwen3-coder:30b` is on five nodes, and its
   Ollama tag is the name to use).
