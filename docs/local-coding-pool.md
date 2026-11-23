# Local coding pool and Companion Memory

`<tailnet>` is your tailnet's DNS suffix, `<laptop>` is your laptop's tailnet
name, and `<hub-host>` is a Companion Hub on the tailnet. Replace all three in
your local setup.

Goal: code locally with the models served by a fleet of Companion Hubs, through
Companion Hub, with Companion Memory available to the same agents.

## Route

`integrations/providers/routing.yaml` declares a `hub_pool` route. Its endpoint
is the Hub's OpenAI-compatible surface, `${COMPANION_HUB_BASE_URL}/api/inference/v1`,
and its key is `COMPANION_HUB_INFERENCE_API_KEY` from
`agent-configs-companion-hub-inference`. The route is used by `opencode`,
`codex`, `aider-desk` and `pi`, ahead of their local and gateway routes.

Launch a client with the key injected from 1Password:

```sh
COMPANION_HUB_BASE_URL=http://<hub-host>:5002 \
  ./bin/agent-store with companion-hub-inference -- opencode
```

## Model names and request shape

- **Name the model by its Ollama tag, not its catalog id.** A catalog id such as
  `qwen3-5-4b` is not a routing name. The pool answers 502 "No pool node
  currently has model … available" for it. The ids on
  `/api/inference/v1/models` are catalog rows, not routing names.
- **Reasoning models need a switch.** Without one, a reasoning model can spend
  the whole `max_tokens` budget on reasoning and return empty `content`. Send
  `"reasoning_effort": "none"`. Setting `"think": false` did not stop this in
  testing.

```sh
curl -s http://<hub-host>:5002/api/inference/v1/chat/completions \
  -H "Authorization: Bearer $COMPANION_HUB_INFERENCE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"<ollama-tag>","reasoning_effort":"none","max_tokens":200,
       "messages":[{"role":"user","content":"Write a one-line Python lambda that doubles n. Code only."}]}'
```

## Pins

`cihub pool pin <node>.<tailnet> --model <ollama-tag> --yes`, run on a Hub. A
pin is a preference. It reorders candidates and never forces a route, so when
the pinned node cannot serve, the request goes to the next node. Undo it with
`cihub pool unpin --model <ollama-tag> --yes`. The routing log marks pinned
decisions as `pinned (this model → peer)`.

## Companion Memory

Set `COMPANION_MEMORY_BASE_URL` to the appliance's Caddy/gateway origin and keep
the `companion-memory` key in 1Password. Then run:

```sh
./bin/agentctl companion memory status
```

If the status check cannot reach a Memory API, find the node that serves it and
set the base URL to that origin.

## Exposure

Serve a Hub API only on the tailnet. Do not publish its port through a public
tunnel or on every interface. Confirm that the inference route rejects a request
without a key before you rely on it.
