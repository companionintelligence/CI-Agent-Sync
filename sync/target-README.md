# Shared agent configuration

This directory is populated from the reviewed
[agent-configs store](https://github.com/mrhegemon/agent-configs). It contains
portable policy and registries only; API keys, OAuth sessions, native app
databases, and machine-specific paths remain local to each agent and machine.

The files under this directory are inputs for humans and setup tooling. They do
not automatically change Claude, Codex, Hermes, OpenClaw, VS Code, or another
client's native configuration.

To opt out or select a narrower set of shared files, copy
`sync.yml.example` to `sync.yml` and edit it. Review updates as normal Git
changes before committing them.
