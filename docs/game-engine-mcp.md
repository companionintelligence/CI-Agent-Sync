# Game-engine MCP setup

The reviewed local stack for the Windows workstation is:

| Host | Selected integration | Local project | Transport | Default state |
| --- | --- | --- | --- | --- |
| Unity 6.3 LTS (`6000.3.19f1`) | CoplayDev Unity MCP `10.3.0` | `CI-Spatial-Companion-Unity`, `CI-XR-Scan-Web-Unity` | stdio plus editor bridge on `127.0.0.1:6400` | verified locally; high-risk opt-in |
| Unreal 5.8.4 | native `ModelContextProtocol` | `CI-MetaHuman` | streamable HTTP on project-configured loopback port | verified locally; high-risk opt-in |
| Blender 5.1 | `ahujasid/mcp-for-blender` `2.2.7` | local Blender profile | stdio plus add-on bridge on `127.0.0.1:9876` | disabled until add-on verification |

`VibeUE` and `VibeMetaHumans` are in-process Unreal toolsets. They are tracked in
`integrations/mcp/engine-plugins.yaml` and served through the native Unreal MCP
endpoint; they must not be registered as separate transports.

The registry keeps the game-engine bundle high-risk and opt-in. Every scene,
asset, script, Python, or editor write must name the target project and receive
client approval immediately before execution. The alternative Unity, Unreal,
and Blender bridges are documented but are not co-installed by default.

For the complete Windows setup, test, cleanup, and re-stage procedure, see
[`game-engine-setup.md`](game-engine-setup.md). The PowerShell entry points are
`scripts/setup-game-engine-stack.ps1`, `scripts/test-game-engine-stack.ps1`,
and `scripts/cleanup-game-engine-tests.ps1`.

For a local check after opening the target editor, use the project-specific
bridge port checks and inspect the editor log before enabling the corresponding
client entry. The portable registry is the source of truth; native client files
contain only the locally selected stdio entries and no credentials.
