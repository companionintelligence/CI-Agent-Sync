# Windows game-engine setup and test runbook

This is the repeatable setup for the Windows development machine under
`C:\devel\ci`. It covers the projects that make up the current game/MetaHuman
stack, the selected MCP transports, alternatives, safety boundaries, cleanup,
and the verification commands.

## Selected versions

| Area | Selected baseline | Why |
| --- | --- | --- |
| Unity editor | `6000.3.19f1` / Unity 6.3 LTS | Both local Unity projects compile on this line. Unity 6.6 is installed, but the projects currently hit upstream package/API errors during a 6.6 import. |
| Unity MCP | CoplayDev Unity MCP `10.3.0` | Pinned PyPI server and pinned Unity package tag; editor bridge verified on `127.0.0.1:6400`. |
| Unreal editor | Unreal Engine `5.8.4` | Current installed 5.8 line used by `CI-MetaHuman`; native ModelContextProtocol is the selected transport. |
| Unreal tools | VibeUE + VibeMetaHumans | In-process Unreal toolsets served through the native Unreal MCP endpoint; no second server is installed. |
| Blender | Blender `5.1` + `mcp-for-blender` `2.2.7` | PyPI package is pinned; add-on bridge uses loopback `127.0.0.1:9876` and remains opt-in until a live Blender check. |

The pins also live in [`integrations/mcp/registry.yaml`](../integrations/mcp/registry.yaml),
with the in-process plugin policy in
[`integrations/mcp/engine-plugins.yaml`](../integrations/mcp/engine-plugins.yaml).

## One-time prerequisites

Install or verify:

- Git and GitHub CLI
- Node.js 22+ and npm
- Python/uv (`uvx` on `PATH`)
- Unity Hub with Unity `6000.3.19f1` and Windows build support
- Unreal Engine 5.8.x with C++/Visual Studio tooling
- Blender 5.1
- Visual Studio with the Desktop C++ and Game Development with C++ workloads

The scripts do not install large editors or silently change credentials. They
verify the installed tools, pin project files, and run the pinned MCP package
help probes.

## Re-setup

From the CI-Agent-Sync checkout:

```powershell
Set-Location C:\devel\ci\CI-Agent-Sync

# Preview file changes and missing-tool failures.
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-game-engine-stack.ps1 -WhatIf

# Apply the Unity project pins and verify the local toolchain.
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-game-engine-stack.ps1
```

The setup script updates only these Unity files in the two project checkouts:

- `ProjectSettings/ProjectVersion.txt`
- `Packages/manifest.json`
- `Packages/packages-lock.json`

It verifies `CI-MetaHuman/Plugins/VibeUE`,
`CI-MetaHuman/Plugins/VibeMetaHumans`, the Unreal MCP port declaration, the
Blender add-on, and the pinned `uvx` packages. It writes the ignored local
machine profile if one is missing at `profiles/machines/local.yaml`, and writes
the ignored local setup report to `local/game-engine-setup.json`.

The script does not rewrite native Codex/Claude/VS Code configuration, copy
credentials, delete caches, or overwrite generated Unreal stage content. The
native Unity entry already used on this workstation is:

```json
{
  "command": "C:\\Users\\hegem\\.local\\bin\\uvx.exe",
  "args": ["--from", "mcpforunityserver==10.3.0", "mcp-for-unity", "--transport", "stdio"],
  "env": { "DISABLE_TELEMETRY": "true" }
}
```

Keep Unreal and Blender client entries opt-in. Unreal can mutate the editor
and Blender can execute Python inside Blender; every write needs a project
target and an approval boundary immediately before execution.

## Test all local projects

Run the complete bounded suite:

```powershell
Set-Location C:\devel\ci\CI-Agent-Sync
npm run game-engine:test
```

The runner tests:

1. CI-Agent-Sync: TypeScript tests, YAML/JSON validation, and production build.
2. `CI-Spatial-Companion-Unity`: Unity batch import/script compilation.
3. `CI-XR-Scan-Web-Unity`: Unity batch import/script compilation.
4. `CI-MetaHuman`: native Backend and Frontend Unreal Automation Specs, then a headless project-load check.
5. `VibeMetaHumans`: plugin checkout completeness; compilation is exercised as part of the `CI-MetaHuman` build.
6. `CI-MetaHuman-Props`: local GLB asset inventory.
7. `companionai`: headless Unreal project-load check as the template project.
8. `_mcp-tools/mcp-for-blender`: local pytest suite plus pinned Blender/Unity MCP CLI help probes.

Each run writes a timestamped, ignored report under
`local/game-engine-tests/<timestamp>/summary.json`. A process exit code alone
is not trusted for Unreal automation: the project-owned test wrappers also
check for crash markers, missing results, truncation, and failed specs.

Useful narrower runs:

```powershell
npm run game-engine:test -- -SkipCompanionAI
npm run game-engine:test -- -SkipUnreal
npm run game-engine:test -- -SkipUnreal -SkipMetaHumanAutomation
npm run game-engine:test -- -TimeoutSeconds 1800
```

## Cleanup boundaries

Preview cleanup first:

```powershell
npm run game-engine:cleanup -- -WhatIf
```

Apply the conservative cleanup:

```powershell
npm run game-engine:cleanup
```

It removes only the known one-off Unity upgrade/editor smoke logs from the
previous setup pass. It intentionally preserves Unity `Library`, Unreal
`Intermediate`, `DerivedDataCache`, `Saved`, the generated `CompanionStage`,
the recoverable `_scratch` backups, and all existing Git changes.

Optional cleanup of this runner's ignored reports and Python caches is explicit:

```powershell
npm run game-engine:cleanup -- -RemoveTestReports -RemovePythonCaches
```

Do not use `git clean -fdx`, delete `Library`, or delete Unreal `Saved` as a
generic reset. Those operations can erase imported assets, local test evidence,
or user work.

## MCP alternatives and why they are not co-installed

| Capability | Selected | Alternative | Policy |
| --- | --- | --- | --- |
| Unity editor bridge | [CoplayDev/unity-mcp](https://github.com/CoplayDev/unity-mcp) `10.3.0` | [ivanmurzak/Unity-MCP](https://github.com/ivanmurzak/Unity-MCP) | Do not install both in one Unity project until transports, package ownership, telemetry, and write permissions are compared. |
| Unreal editor bridge | Native Unreal 5.8 `ModelContextProtocol` | [ChiR24/Unreal_mcp](https://github.com/ChiR24/Unreal_mcp) | The native endpoint is already working; keep the external bridge as a fallback, not a second listener. |
| Unreal toolsets | [VibeUE](https://github.com/kevinpbuckley/VibeUE) + [VibeMetaHumans](https://github.com/kevinpbuckley/VibeMetaHumans) | None required | These are in-process toolsets, not independent MCP servers. |
| Blender bridge | [ahujasid/mcp-for-blender](https://github.com/ahujasid/mcp-for-blender) `2.2.7` | [Blender official MCP](https://www.blender.org/lab/mcp-server/) | Run only one add-on bridge per Blender process. |
| Unity-native assistant | Unity AI Assistant package | Coplay Unity MCP | AI Assistant is an optional in-editor assistant, not a replacement MCP transport. |

The selected bundle is marked high-risk in
[`integrations/capability-bundles.yaml`](../integrations/capability-bundles.yaml).
Servers are loopback-bound, pinned, telemetry-controlled where supported, and
kept opt-in for editor writes.

## Re-stage the retro datacenter

The generated stage is authored by
`CI-MetaHuman/Deployment/author_diorama.py`. Before rerunning it, preserve the
current map if it is valuable. The previous setup used a recoverable copy under
`C:\devel\ci\_scratch` and imported the local GLBs from
`C:\devel\llm-metahuman\scene\glb`.

The authoring command is:

```powershell
$env:MHLLM_GLB_DIR = 'C:\devel\llm-metahuman\scene\glb'
$env:MHLLM_MH_DIR = 'C:\devel\ci\CI-MetaHuman\Deployment\metahuman'
$env:MHLLM_AUDIO_DIR = 'C:\devel\ci\CI-MetaHuman\Deployment\audio'
$env:MHLLM_GEN_DIR = 'C:\devel\ci\CI-MetaHuman\Deployment\generated'
$env:MHLLM_AUTHOR_RESULT = 'C:\devel\ci\CI-MetaHuman\Saved\AUTHOR_RESULT.txt'

& 'C:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\UnrealEditor-Cmd.exe' `
  'C:\devel\ci\CI-MetaHuman\MetaHumanLocalLLM.uproject' `
  -run=pythonscript -script=Deployment\author_diorama.py -unattended -nullrhi -nosplash -noP4 -stdout -utf8output -NoLogTimes `
  '-ini:EditorPerProjectUserSettings:[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]:bAutoStartServer=False'
```

Treat `Saved/AUTHOR_RESULT.txt` ending in `SUCCESS` and a non-zero map artifact
as the authoring gate. A visual editor capture remains necessary for camera,
materials, and composition.

## Current limitations

- Unity 6.6 is installed but needs an upstream package migration before it can
  replace the 6.3 LTS project baseline.
- Blender’s package and add-on are installed, but a live `9876` listener check
  requires Blender to be open.
- The Sketchfab collection is not a reproducible anonymous download source;
  authenticated download access is required. Keep local GLBs or a separately
  versioned asset manifest for future stage reconstruction.
