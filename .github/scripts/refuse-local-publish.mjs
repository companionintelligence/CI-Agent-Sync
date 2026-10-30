#!/usr/bin/env node

// prepublishOnly: stop `npm publish` from a working tree.
//
// npm publishes are permanent, and "files" in package.json outranks .gitignore, so a
// publish from a checkout ships whatever happens to sit in its shipped directories.
// Releases come from a tag through .github/workflows/npm-publish.yml, which publishes a
// tarball it has checked against git first. `npm publish <tarball>` skips lifecycle
// scripts, so this does not get in the workflow's way; GITHUB_ACTIONS is what a publish
// from a runner looks like if someone changes that.
//
// The one-time name reservation (see the workflow header) publishes a placeholder from
// an empty directory with its own package.json, so it is not affected either.

if (process.env.GITHUB_ACTIONS === "true") process.exit(0);

console.error(`
Refusing to publish this package from a working tree.

"files" in package.json outranks .gitignore, so \`npm publish\` here would put whatever
sits in this checkout's shipped directories (keys, tokens, local profiles, raw
agent-config snapshots) into a public, permanent package. Releases are built from a tag by
.github/workflows/npm-publish.yml, which checks the tarball against git before it publishes.

  To see what would ship:  npm pack --dry-run
  To cut a release:        follow RELEASING at the top of .github/workflows/npm-publish.yml
`);
process.exit(1);
