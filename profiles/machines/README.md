# Machine overlays

The tracked profiles describe intent. A machine overlay describes only local
capabilities and paths, and is never required for the store to remain useful.

Create `local.yaml` from `macos-laptop.yaml.example` and keep it ignored. Use
environment variables for paths that differ between machines:

```yaml
ci_root: "${HOME}/devel/ci"
companion_hub_root: "${CI_ROOT}/Companion-Hub"
companion_memory_root: "${CI_ROOT}/Companion-Memory"
ci_engineering_root: "${CI_ROOT}/CI-Engineering"
```

Do not put API keys, OAuth exports, native app databases, or machine-specific
hostnames in an overlay. Provider credentials belong in the platform's native
secret store; this repository only records their names and injection rules.

The bootstrap order is deliberately idempotent:

1. install or verify prerequisites;
2. create the local overlay;
3. set provider credentials through `agent-store credentials set`;
4. audit before installing optional skills, plugins, or MCP servers;
5. install only reviewed entries from the manifests;
6. run smoke checks and snapshot redacted state.
