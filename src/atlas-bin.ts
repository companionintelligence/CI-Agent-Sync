#!/usr/bin/env node

// `agent-atlas` is `agentctl atlas` under its own name, as bin/agent-atlas is in a
// checkout. cli.ts reads process.argv when it loads, so the mode goes in first.
export {};

process.argv.splice(2, 0, "atlas");
await import("./cli.ts");
