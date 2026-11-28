// The redactor behind backups, snapshots and audit output, against fake secrets planted in
// every place a real config keeps them. Values are built at run time, so this file holds none.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, selfInvocation } from "./core.ts";
import { redactSource } from "./operations.ts";
import { redactConfigText, type ConfigKind } from "./redact-config.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// No recognisable shape, so only its position can give a value away.
const plain = (tag: string): string => `plain${tag}${"q7".repeat(12)}`;
const survivors = (text: string, tags: string[]): string[] => tags.filter((tag) => text.includes(`plain${tag}`));

function positionChecks(): void {
  const shaped = `gh${"p_"}${"A1b2".repeat(9)}`;
  const files: Array<[string, ConfigKind, string[], string]> = [
    ["YAML", "yaml", ["H1", "H2", "H3", "H4"], [
      "providers:", "  x:", `    api_key: ${plain("H1")}`, "env:", `  GITHUB_PAT: ${plain("H2")}`,
      "mcp:", `  args: ['--api-key=${plain("H3")}']`, `url: https://user:${plain("H4")}@host.example/x`,
    ].join("\n")],
    ["JSON", "json", ["O1", "O2", "O3", "O4", "O5", "O6", "O7", "O8", "O9"], JSON.stringify({
      env: { OPENAI_KEY: plain("O1"), ANYTHING: plain("O2") },
      gateway: { auth: { token: plain("O3") } },
      SLACK_BOT_KEY: plain("O4"),
      hooks: { cmd: `curl -H 'Authorization: Bearer ${plain("O5")}'` },
      mcpServers: { a: { args: ["--token", plain("O6"), "--header", `X-Thing: ${plain("O7")}`, `--pat=${plain("O8")}`], env: [`API=${plain("O9")}`] } },
      note: shaped,
    })],
    ["JSONC", "json", ["J1", "J2", "J3"], [
      "// a comment", "{", `  "provider": { "x": { "options": { "apiKey": "${plain("J1")}", }, }, }, /* block */`,
      `  "mcp": { "y": { "headers": { "Authorization": "Bearer ${plain("J2")}" }, "environment": { "ANY": "${plain("J3")}" } } },`, "}",
    ].join("\n")],
    ["TOML", "toml", ["X1", "X2", "X3", "X4", "X5", "X6"], [
      "[mcp_servers.x]", `args = ["--token", "${plain("X1")}"]`, `env = { GITHUB_PAT = "${plain("X2")}", OTHER = "${plain("X3")}" }`,
      `url = "https://u:${plain("X4")}@host.example/mcp"`, `http_headers = { Authorization = "Bearer ${plain("X5")}" }`,
      "", '[projects."/home/someone/client-work"]', `note = "${plain("X6")}"`,
    ].join("\n")],
  ];
  for (const [name, kind, tags, raw] of files) {
    const out = redactConfigText(raw, kind, { home: "/home/someone" });
    assert(survivors(raw, tags).length === tags.length, `${name} fixture does not plant every value`);
    assert(survivors(out, tags).length === 0, `${name} redaction left ${survivors(out, tags).join(", ")}`);
    assert(!out.includes(shaped), `${name} redaction left a token-shaped value`);
    assert(!out.includes("client-work"), `${name} redaction kept a per-folder table`);
  }
}

function readabilityChecks(): void {
  const kept = {
    model: "claude-test", command: "npx", args: ["-y", "some-server", "/home/someone/data", "--token", "${TOKEN}"],
    env: { A: "${A_TOKEN}", B: "op://vault/item/field", C: "$HOME_DIR" }, apiKey: "${OPENAI_API_KEY}",
    headers: { Authorization: "Bearer ${API_KEY}" }, bearer_token_env_var: "MY_TOKEN_NAME", max_tokens: 500, trackTokenUsage: true,
  };
  const out = redactConfigText(JSON.stringify(kept), "json", { home: "/home/someone" });
  const expected = JSON.stringify({ ...kept, args: ["-y", "some-server", "<home>/data", "--token", "${TOKEN}"] }, null, 2);
  assert(out === `${expected}\n`, `redaction changed values that are not secrets:\n${out}`);
  const personal = redactConfigText(JSON.stringify({ autoMode: { environment: ["internal service notes"] }, owner: "someone@example.org" }), "json", { home: "/home/someone" });
  assert(!personal.includes("internal service notes") && !personal.includes("someone@example.org"), "redaction kept machine notes or a mail address");
  const selected = redactConfigText(JSON.stringify({ history: [plain("S1")], mcpServers: { a: { command: "npx" } } }), "json", { select: (d) => ({ mcpServers: d.mcpServers }) });
  assert(!selected.includes("plainS1") && selected.includes('"command": "npx"'), "selecting one part of a file did not drop the rest");
}

function failClosedChecks(): void {
  for (const kind of ["json", "yaml", "toml"] as ConfigKind[]) assert(redactConfigText(" \n", kind) === "", `a blank ${kind} file was treated as an error`);
  const folder = mkdtempSync(join(tmpdir(), "redact-"));
  try {
    for (const [kind, name] of [["json", "bad.json"], ["yaml", "bad.yaml"], ["toml", "bad.toml"]] as Array<[ConfigKind, string]>) {
      const source = join(folder, name);
      writeFileSync(source, `api_key: "${plain("F1")}\n{ [ =`);
      let message = "";
      try {
        redactSource({ relative: name, source, kind }, join(folder, "out", name));
      } catch (error) {
        message = String(error);
      }
      assert(message.includes("could not be parsed"), `an unparseable ${kind} file was not refused`);
      assert(!message.includes("plain") && !existsSync(join(folder, "out", name)), `an unparseable ${kind} file leaked into the output or the error`);
    }
    const input = join(folder, "settings.json");
    writeFileSync(input, JSON.stringify({ token: plain("C1") }));
    const run = spawnSync(process.execPath, selfInvocation(["redact-config", input, join(folder, "copy.json")]), { cwd: ROOT, encoding: "utf8" });
    assert(run.status === 0 && !readFileSync(join(folder, "copy.json"), "utf8").includes("plainC1"), `agentctl redact-config failed: ${run.stderr}`);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// What `agentctl audit` pipes native tool output through.
function streamChecks(): void {
  const tags = ["A1", "A2", "A3", "A4", "A5"];
  const input = [
    `{"token": "${plain("A1")}"}`, `"apiKey":"${plain("A2")}",`, `Authorization: Bearer ${plain("A3")}`,
    `Cookie: a=1; session=${plain("A4")}`, `OPENAI_API_KEY=${plain("A5")}`, "2 servers connected",
  ].join("\n");
  const run = spawnSync(process.execPath, selfInvocation(["redact"]), { cwd: ROOT, input, encoding: "utf8" });
  assert(run.status === 0, `agentctl redact failed: ${run.stderr}`);
  assert(survivors(run.stdout, tags).length === 0, `agentctl redact left ${survivors(run.stdout, tags).join(", ")}`);
  assert(run.stdout.includes("2 servers connected"), "agentctl redact dropped ordinary output");
}

export function redactConfigChecks(): void {
  positionChecks();
  readabilityChecks();
  failClosedChecks();
  streamChecks();
}
