# Agent audit checklist

Each agent is reviewed across the same surfaces so configuration drift is
visible instead of being hidden behind a successful launch.

1. Installation: version, executable/app bundle, update channel, package
   manager, and duplicate installations.
2. Configuration: effective config path, schema validity, deprecated fields,
   profiles, model defaults, endpoints, and native app settings.
3. Credentials: provider presence only, auth mode, expiry/refresh state,
   Keychain or native credential storage, and accidental plaintext exposure.
4. Skills and extensions: installed/enabled inventory, source/trust, missing
   requirements, duplicate IDs, load errors, and stale local copies.
5. Tools and MCP: enabled tools, command permissions, browser/desktop access,
   local network exposure, and server reachability from the calling process.
6. Workspace behavior: rules, memories, system prompts, project trust, working
   directory, hooks, and cross-agent file access.
7. Runtime: service/LaunchAgent state, local-vs-remote gateway, ports,
   health probes, logs, session state, and recovery path.
8. Security and maintenance: loopback binding, explicit allowlists, update
   status, dependency advisories, backups, and reproducible repair commands.
9. Smoke tests: one safe local command, one configured provider check when
   credentials are present, and one tool/skill check appropriate to the agent.

## Phases

- Phase 1: Hermes and OpenClaw desktop/CLI foundations.
- Phase 2: Claude, Codex, Antigravity, OpenCode, Aider Desk, and Pi inventory.
- Phase 3: normalize shared providers, skills, helper commands, and docs.
- Phase 4: repeatable smoke tests and maintenance/update checks.
