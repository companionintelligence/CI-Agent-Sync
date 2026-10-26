# ADR-0002: Node-only control plane

Status: accepted

The control plane runs on Node 22 with TypeScript type-stripping and no
framework. Remaining Ruby scripts are compatibility paths and are ported when
touched. `bin/openclaw-runtime` is the only OpenClaw entry point the store
trusts, because older npm installs on PATH reject the desktop config schema.
