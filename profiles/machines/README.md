# Machine overlays

The tracked profiles describe intent. A machine overlay describes only local
capabilities and paths, and is never required for the store to remain useful.

Create `local.yaml` from the matching platform example and keep it ignored. Use
environment variables for paths that differ between machines:

```yaml
ci_root: "${HOME}/devel/ci"
ci_common_root: "${CI_ROOT}/CI-Common"
ci_brand_studio_root: "${CI_ROOT}/CI-Brand-Studio"
companion_hub_root: "${CI_ROOT}/CI-Hub"
companion_memory_root: "${CI_ROOT}/CI-Memory"
ci_engineering_root: "${CI_ROOT}/CI-Engineering"
```

Do not put API keys, OAuth exports, native app databases, or machine-specific
hostnames in an overlay. Provider credentials belong in the platform's native
secret store; this repository only records their names and injection rules.

The shared credential helper uses 1Password CLI with desktop integration as the
portable backend. macOS Keychain and Linux Secret Service remain migration
sources until each provider has been verified in 1Password. Windows uses the
same `op` flow rather than copying client-native credentials.

The bootstrap order is deliberately idempotent:

1. install or verify prerequisites;
2. create the local overlay;
3. set provider credentials through `agent-store credentials set`;
4. audit before installing optional skills, plugins, or MCP servers;
5. install only reviewed entries from the manifests;
6. run smoke checks and snapshot redacted state.
