// scripts/scan-credentials.sh against generated fake values of every format it claims to
// catch. The values are built at run time, so this file holds none.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./core.ts";

const SCRIPT = join(ROOT, "scripts", "scan-credentials.sh");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function scan(files: Record<string, string>): { status: number | null; listed: string[]; output: string } {
  const folder = mkdtempSync(join(tmpdir(), "credential-scan-"));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(folder, name), `${content}\n`);
    const result = spawnSync(SCRIPT, [folder], { encoding: "utf8" });
    const listed = result.stdout.split("\n").filter(Boolean).map((line) => line.replace(/^\.\//, "")).sort();
    return { status: result.status, listed, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

export function credentialScanChecks(): void {
  const seed = 0x5ca7;
  let state = seed;
  const draw = (alphabet: string, length: number): string => Array.from({ length }, () => {
    state = (state * 48_271) % 2_147_483_647;
    return alphabet[state % alphabet.length];
  }).join("");
  const mixed = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const key = ["PRIVATE", "KEY"].join(" ");
  const slack = (letter: string) => `${["xo", "x"].join("")}${letter}-${draw("0123456789", 12)}-${draw(mixed, 24)}`;
  const secrets = [
    `sk-${draw(mixed, 48)}`,
    `sk-proj-${draw(mixed, 40)}_${draw(mixed, 10)}`,
    `sk-svcacct-${draw(mixed, 48)}`,
    `sk-ant-api03-${draw(mixed, 24)}-${draw(mixed, 24)}`,
    `sk-or-v1-${draw("0123456789abcdef", 40)}`,
    ...["p", "o", "u", "s", "r"].map((letter) => `gh${letter}_${draw(mixed, 36)}`),
    `github_pat_${draw(mixed, 22)}_${draw(mixed, 59)}`,
    `glpat-${draw(mixed, 20)}`,
    `hf_${draw(mixed, 34)}`,
    `npm_${draw(mixed, 36)}`,
    `AIza${draw(mixed, 35)}`,
    `sk_live_${draw(mixed, 24)}`,
    `rk_live_${draw(mixed, 24)}`,
    ...["a", "b", "e", "p", "r", "s"].map(slack),
    `xapp-1-${draw(upper, 11)}-${draw("0123456789", 13)}-${draw("0123456789abcdef", 64)}`,
    `AKIA${draw(upper, 16)}`,
    `ASIA${draw(upper, 16)}`,
    `Authorization: Bearer ${draw(mixed, 32)}`,
    `Authorization: Basic ${Buffer.from(`user:${draw(mixed, 20)}`).toString("base64")}`,
    `{"authorization": "basic ${draw(mixed, 32)}"}`,
    ...["", "RSA ", "EC ", "OPENSSH ", "ENCRYPTED "].map((kind) => `-----BEGIN ${kind}${key}-----`),
    `-----BEGIN PGP ${key} BLOCK-----`,
  ];
  const planted = Object.fromEntries(secrets.map((secret, index) => [`secret-${String(index).padStart(2, "0")}.txt`, `value: ${secret}`]));
  // Placeholders, public material and names that only look close.
  const ordinary = {
    "placeholders.md": "OPENAI_API_KEY=sk-... and ghp_<your-token> and Authorization: Bearer $TOKEN",
    "headers.md": "Authorization: Basic <base64>; the Bearer scheme; AKIA is a prefix; npm_config_cache",
    "public.pem": "-----BEGIN CERTIFICATE-----\n-----BEGIN PUBLIC KEY-----",
    "names.txt": "task-runner-for-everything disk-cleanup-scheduled-nightly xox is a prefix",
  };
  const found = scan({ ...planted, ...ordinary });
  assert(found.status === 1, `the credential scan exited ${found.status}, not 1 (seed ${seed}): ${found.output.slice(-300)}`);
  const expected = Object.keys(planted).sort();
  const missed = expected.filter((name) => !found.listed.includes(name)).map((name) => planted[name].slice(7, 19));
  assert(missed.length === 0, `the credential scan missed values starting ${missed.join(", ")} (seed ${seed})`);
  assert(found.listed.every((name) => expected.includes(name)), `the credential scan flagged ordinary text: ${found.listed.filter((name) => !expected.includes(name)).join(", ")}`);
  assert(secrets.every((secret) => !found.output.includes(secret)), "the credential scan printed a secret");
  const clean = scan(ordinary);
  assert(clean.status === 0 && clean.listed.length === 0, `the credential scan failed ordinary text (exit ${clean.status}): ${clean.output}`);
}
