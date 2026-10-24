# Harness parity and test tiers

Parity means every harness has the same provider policy, safety contract,
workspace context, and reviewed MCP vocabulary. It does not mean copying the
same native config into every app.

| Tier | Command | What it proves |
| --- | --- | --- |
| Inventory | `agentctl inventory` | Installed clients and config roots are visible |
| Static | `agentctl doctor` | Commands, manifests, paths, and secret-store metadata are sane |
| Smoke | `agentctl test` | Installed harnesses answer a safe version/help probe |
| Local live | `agentctl test --live-local` | A local model endpoint accepts a harmless coding request |
| MCP live | client-native test | Transport, auth, and tool list work from that client |
| Mutation | explicit owner approval | Publishing, scheduling, device control, or destructive changes are allowed |

Missing optional desktop apps are warnings, not false failures. A protected
endpoint returning HTTP 401 proves reachability but not authentication; the
health result reports that distinction.
