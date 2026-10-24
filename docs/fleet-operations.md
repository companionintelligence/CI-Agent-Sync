# Companion Intelligence fleet operations

This store carries the policy and evidence needed to operate the CI-Hub
inference pool across machines. It does not copy host keys, API keys, native
auth databases, or live application state.

## Safe order of operations

1. Read the target's `fleet/pool-policy.yaml` and the live `cihub fleet list`.
2. Preserve any operator exclusions and dirty checkouts.
3. Use strict SSH host-key verification. A changed host key is a stop signal,
   not an invitation to bypass verification.
4. Use only cached noninteractive `sudo -n` authorization. Never pass a
   password through an agent, script, or chat.
5. Run `cihub fleet backends --backends ollama` without `--execute` first.
6. Apply only changes whose engine, Hub, and container-bridge checks pass.
7. Match each Hub context cap to the engine's `OLLAMA_CONTEXT_LENGTH`; do not
   raise the engine context as a side effect of repairing metadata.
8. Re-run the local endpoint checks and `cihub pool doctor` on the repaired
   node, then wait one health-poll interval before judging peer metadata.

## Current operator boundary

The 2026-10-24 repair pass explicitly left `core-7` and `fzzy` untouched. Core
5 also remains blocked until its changed SSH host key is verified. These are
stateful safety boundaries, not failed attempts to be silently retried.

## Portable health gate

A node is ready for pool participation only when all of these are true from
the calling process or Hub container:

- Ollama responds on `/api/tags`.
- CI-Hub responds on `/api/health`.
- CI-Hub pool identification responds on `/api/inference/pool/identify`.
- The Hub container can reach the host inference engine.
- The Hub context cap matches the engine context limit.
- Peer authentication is signed and pinned.

The live fleet may contain additional nodes or different limits. The policy's
observed values are evidence from one repair pass, not a substitute for live
discovery.
