#!/usr/bin/env node

// Guards the npm tarball before it can be published (see .github/workflows/npm-publish.yml).
//
//   node .github/scripts/check-npm-tarball.mjs <tarball.tgz> [--rev <git rev>] [--all]
//   node .github/scripts/check-npm-tarball.mjs --entries <file> --tracked <file> [--all]
//
// "files" in package.json outranks .gitignore, so whatever sits in a shipped directory
// of the machine that runs `npm pack` goes into the tarball, tracked or not. A
// hand-kept list of bad names cannot keep up with that, so the first rule does not
// depend on names at all:
//
//   1. Every file must be tracked by git at <rev> (default HEAD). The one exception is
//      dist/, which is build output: it may hold only the compiled form of a tracked
//      src/ file. A key, a token, a raw agent-config snapshot or any other local file
//      has no entry in git, so it fails here whatever it is called.
//   2. Common credential and local-state name patterns fail even when the file IS tracked,
//      because publishing to npm is permanent. This list is best effort and cannot be
//      complete: a tracked file whose name it does not know is published as it is.
//   3. The entries the package cannot run without must be there.
//
// What that guarantees: nothing git does not track at <rev> is in the tarball (compiled
// dist/ aside), and none of the patterns below is. What it does not: a tracked file is
// published as it is, whatever it contains and whatever it is called. What is tracked, and
// so already public in the repository, is the owner's call, not something a list of names
// can settle.
//
// Exit 0: clean. Exit 1: it lists the offending paths (the first 200 findings, or all
// of them with --all). Exit 2: it could not check (unreadable tarball, git failure, bad
// arguments), which must stop a release too.
//
// The second form takes tar-style names (package/...) and git paths from two files,
// one per line; the test script uses it to exercise the rules without a tarball.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Relative to package/. dist/cli.js and dist/atlas-bin.js are the bin targets.
const REQUIRED = [
  "package.json",
  "LICENSE",
  "README.md",
  "dist/cli.js",
  "dist/atlas-bin.js",
  "bin/agentctl",
  "bin/agent-store-legacy",
  "web/index.html",
  "web/app.js",
  "sync/manifest.yaml",
];

const EXAMPLE = /\.(example|sample|template)(\.|$)/;
const KEY_EXTENSION = /\.(pem|key|p12|pfx|jks|keystore|truststore|p8|ppk|gpg|pgp|asc|kdbx)$/;
const STATE_EXTENSION = /\.(sqlite3?|db|log|bak|orig|rej|swp|swo|tmp|pid)$/;
// Not code or assets, so a name like this is more likely to hold a secret than not.
// "onepassword" and "tokens.css" must not trip it, hence the letter boundaries and the
// list of extensions that are plainly code or assets.
const CREDENTIAL_WORD = /(^|[^a-z])(credentials?|secrets?|tokens?|passwords?|passwd|api[-_]?keys?|apikeys?|private[-_]?keys?|service[-_]?accounts?|bearer)([^a-z]|$)/;
const CODE_OR_ASSET = /\.(css|md|js|mjs|cjs|ts|html|svg|png|woff2|rb|zsh|sh)$/;
const HOME_DOTFILES = new Set([
  ".netrc", "_netrc", ".git-credentials", ".gitcredentials", ".npmrc", ".pypirc", ".dockercfg",
  ".htpasswd", ".pgpass", ".my.cnf", ".s3cfg", ".boto", ".bash_history", ".zsh_history",
  ".python_history", ".node_repl_history", "known_hosts", "authorized_keys",
]);

// [test(path, lowercased basename), why]. Run against every entry, tracked or not.
const DENY = [
  [(p) => /(^|\/)(node_modules|\.git)\//.test(p), "dependency tree or git metadata"],
  [(p) => /^(src|video|reports|local|state|work)\//.test(p), "source, video or local state, none of which ships"],
  [(p) => /(^|\/)(local|work)\//.test(p) || /(^|\/)(state|reports)\/raw\//.test(p), "local working state"],
  [(p) => /\.redacted\./.test(p), "redacted snapshot of a personal agent config"],
  [(p) => p === "agents/vscode/extensions.txt", "personal editor extension list"],
  [(p) => p === "sync/targets.yaml" || p === "profiles/machines/local.yaml", "local override file"],
  [(p) => p === "dist/test.js", "test harness, not part of the package"],
  [(p, b) => !EXAMPLE.test(b) && /(^|[._-])env(rc)?($|[._-])/.test(b), "environment file"],
  [(p, b) => KEY_EXTENSION.test(b), "key, certificate or keystore file"],
  [(p, b) => /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(b), "ssh key"],
  [(p, b) => HOME_DOTFILES.has(b), "credential store or shell history"],
  [(p) => /(^|\/)\.(aws|ssh|gnupg|docker|kube)\//.test(p), "credential directory"],
  [(p, b) => /^\.?(auth|oauth|credentials?)(\.[a-z0-9]+)*$/.test(b), "credential file"],
  [(p, b) => !EXAMPLE.test(b) && CREDENTIAL_WORD.test(b) && !CODE_OR_ASSET.test(b), "name says credential, secret or token"],
  [(p, b) => STATE_EXTENSION.test(b) || b === ".ds_store" || b === "thumbs.db", "database, log, backup or editor leftover"],
];

function fail(message) {
  console.error(message);
  process.exit(2);
}

function parseArguments(argv) {
  const options = { tarball: null, rev: "HEAD", entries: null, tracked: null, all: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") {
      options.all = true;
    } else if (arg === "--rev" || arg === "--entries" || arg === "--tracked") {
      const value = argv[++i];
      if (!value) fail(`${arg} needs a value`);
      options[arg.slice(2)] = value;
    } else if (arg.startsWith("--")) {
      fail(`unknown option ${arg}`);
    } else if (options.tarball === null) {
      options.tarball = arg;
    } else {
      fail(`unexpected argument ${arg}`);
    }
  }
  const lists = options.entries !== null && options.tracked !== null;
  if (options.tarball === null && !lists) {
    fail("usage: check-npm-tarball.mjs <tarball.tgz> [--rev <git rev>] [--all]\n   or: check-npm-tarball.mjs --entries <file> --tracked <file> [--all]");
  }
  if (options.tarball !== null && (options.entries !== null || options.tracked !== null)) {
    fail("give either a tarball or --entries with --tracked, not both");
  }
  return options;
}

function readLines(file) {
  return readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
}

function tarballEntries(tarball) {
  try {
    const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    return listing.split("\n").filter((line) => line !== "");
  } catch (error) {
    return fail(`could not list ${tarball}: ${error.message}`);
  }
}

function trackedPaths(rev) {
  try {
    const out = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", "--name-only", rev], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    return out.split("\0").filter((line) => line !== "");
  } catch (error) {
    return fail(`could not list the files git tracks at ${rev}: ${error.message}`);
  }
}

const options = parseArguments(process.argv.slice(2));
const entries = options.tarball !== null ? tarballEntries(options.tarball) : readLines(options.entries);
const tracked = new Set(options.tarball !== null ? trackedPaths(options.rev) : readLines(options.tracked));
const where = options.tarball !== null ? `git at ${options.rev}` : "the tracked list";

const problems = [];
const present = new Set();

for (const entry of entries) {
  if (entry.endsWith("/")) continue; // a directory entry
  if (!entry.startsWith("package/") || /(^|\/)\.\.(\/|$)/.test(entry)) {
    problems.push([entry, "not a normal npm tarball path"]);
    continue;
  }
  const path = entry.slice("package/".length);
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  present.add(path);

  if (path.startsWith("dist/")) {
    const source = /^dist\/(.+)\.js$/.exec(path);
    if (source === null || !tracked.has(`src/${source[1]}.ts`)) {
      problems.push([path, "dist/ may only hold the compiled form of a tracked src/*.ts file"]);
    }
  } else if (!tracked.has(path)) {
    problems.push([path, `not tracked by ${where}`]);
  }

  for (const [matches, why] of DENY) {
    if (matches(path, base)) problems.push([path, why]);
  }
}

for (const required of REQUIRED) {
  if (!present.has(required)) problems.push([required, "missing, and the package cannot run without it; check \"files\" in package.json"]);
}

if (problems.length > 0) {
  const paths = new Set(problems.map(([path]) => path));
  const width = Math.max(...problems.map(([, why]) => why.length));
  console.error(`npm tarball check FAILED: ${paths.size} path${paths.size === 1 ? "" : "s"} (${problems.length} finding${problems.length === 1 ? "" : "s"})`);
  const shown = options.all ? problems : problems.slice(0, 200);
  for (const [path, why] of shown) console.error(`  ${why.padEnd(width)}  ${path}`);
  if (shown.length < problems.length) console.error(`  ... and ${problems.length - shown.length} more findings (--all lists them)`);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.error(`::error::the tarball contains ${paths.size} path(s) that must not be published, or lacks a required one; see the list above`);
  }
  process.exit(1);
}

const files = entries.filter((entry) => !entry.endsWith("/")).length;
console.log(`npm tarball check passed: ${files} files, all tracked by ${where} or compiled from a tracked src/ file, none matching the credential name patterns, every required entry present`);
