import { spawn } from "node:child_process";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ROOT, fileExists, readText, redactSecrets, runCommand, runCommandAsync, safeDetail } from "./core.ts";
import { ACTION_TAKEN, ItfError, NONDET_PICKS, decodeItfValue, itfAction, itfPicks, parseItfTrace, type ItfValue } from "./itf.ts";
import { classifyNanoKvmMcp, classifyProduct, envName, loadKvmTargets, mcpSnippet, nanoKvmKeyEnv, rowStatus } from "./kvm.ts";
import { summarizeTailscaleStatus } from "./platform.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function kvmChecks(): void {
  // MCP classification follows the HTTP status of /api/mcp on NanoKVM firmware.
  assert(classifyNanoKvmMcp(401) === "enabled_auth_required", "401 from /api/mcp must mean MCP is on and keyed");
  assert(classifyNanoKvmMcp(200) === "enabled_unauthenticated", "200 without a key must be flagged, not treated as safe");
  assert(classifyNanoKvmMcp(403) === "disabled_or_blocked", "403 must not look like an enabled MCP");
  assert(classifyNanoKvmMcp(404) === "not_in_firmware", "404 must point at firmware, not at a keyed MCP");
  assert(classifyNanoKvmMcp(null) === "not_reachable" && classifyNanoKvmMcp(500) === "unexpected", "unknown answers must not be guessed");
  // Product detection: the NanoKVM title wins, PiKVM is recognised by its login redirect or API auth.
  assert(classifyProduct({ rootStatus: 200, rootTitle: "NanoKVM" }) === "nanokvm", "NanoKVM title not recognised");
  assert(classifyProduct({ rootStatus: 302, redirectsToLogin: true }) === "pikvm", "PiKVM login redirect not recognised");
  assert(classifyProduct({ rootStatus: 200, apiInfoStatus: 401 }) === "pikvm", "PiKVM API 401 not recognised");
  assert(classifyProduct({ rootStatus: null }) === "unreachable", "a silent device must not be reported as a product");
  // Status: excluded or unreachable devices are never reported as ready.
  assert(rowStatus({ enabled: true, product: "nanokvm", mcp: "enabled_auth_required", model: "nanokvm" }).status === "ok", "keyed NanoKVM MCP should be ok");
  assert(rowStatus({ enabled: true, product: "nanokvm", mcp: "enabled_unauthenticated", model: "nanokvm" }).status === "warn", "open MCP must warn");
  assert(rowStatus({ enabled: true, product: "nanokvm", mcp: "disabled_or_blocked", model: "nanokvm" }).status === "warn", "disabled MCP must warn");
  assert(rowStatus({ enabled: false, product: "unreachable", mcp: "not_reachable", model: "nanokvm" }).status === "skipped", "disabled targets must be skipped");
  assert(envName("core-14-kvm") === "CORE_14_KVM" && nanoKvmKeyEnv("core-14-kvm") === "NANOKVM_CORE_14_KVM_API_KEY", "env naming drifted");

  // Every probed NanoKVM that may be driven has a 1Password env line, and nothing excluded does.
  const targets = loadKvmTargets().targets;
  const envFile = readText("integrations/kvm/op.env.example");
  for (const [name, spec] of Object.entries(targets)) {
    assert(["nanokvm", "pikvm"].includes(spec.model), `${name} has an unknown model`);
    if (spec.model === "nanokvm" && !spec.excluded_from_mcp) assert(envFile.includes(`${nanoKvmKeyEnv(name)}=op://Agent Configs/agent-configs-kvm-${name}/credential`), `${name} has no 1Password key line`);
    if (spec.excluded_from_mcp) assert(!envFile.includes(nanoKvmKeyEnv(name)), `${name} is excluded from MCP but has a key line`);
  }
  const snippet = mcpSnippet("core-14-kvm", targets["core-14-kvm"], "https");
  assert(snippet.includes("${NANOKVM_CORE_14_KVM_API_KEY}") && snippet.includes("https://core-14-kvm/api/mcp"), "MCP snippet must use an env placeholder and the device endpoint");
  assert(!/Bearer\s+[A-Za-z0-9]{12,}/.test(snippet), "MCP snippet must never contain a literal key");

  // Operator decisions from the fleet roster stay enforced in the sync targets.
  const fleetTargets = readText("integrations/fleet/targets.yaml");
  assert(!/^\s{2}ci-core:/m.test(fleetTargets), "removed fleet target must stay removed");
}

function itfChecks(): void {
  // A hand-written trace shaped like `quint run --mbt --out-itf` output, vars listed twice included.
  const text = readText("src/fixtures/itf/traffic-light.itf.json");
  const trace = parseItfTrace(text);
  assert(isDeepStrictEqual(trace.vars, ["light", "ticks", "seen", "visits", "last", ACTION_TAKEN, NONDET_PICKS]), "ITF vars were not deduplicated in order");
  assert(trace.states.length === 3 && trace.meta.format === "ITF", "ITF states or #meta were lost");
  const [first, second, third] = trace.states;
  assert(second.ticks === 2n && third.ticks === 9007199254740993n, "#bigint did not decode to an exact bigint");
  assert(third.seen instanceof Set && isDeepStrictEqual(third.seen, new Set(["Green", "Red", "Yellow"])), "#set did not decode to a Set");
  assert(third.visits instanceof Map && (third.visits as Map<ItfValue, ItfValue>).get("Green") === 1n && isDeepStrictEqual(first.visits, new Map()), "#map did not decode to a Map");
  assert(isDeepStrictEqual(second.last, [1n, "step"]), "#tup did not decode to an array");
  assert(isDeepStrictEqual(second.light, { tag: "Green", value: [] }), "a variant did not stay a { tag, value } record");
  assert(itfAction(first) === "init" && itfAction(second) === "step", "itfAction did not read mbt::actionTaken");
  assert(isDeepStrictEqual(itfPicks(second), { next: "Green", wait: 2n }), "itfPicks did not unwrap Some");
  assert(isDeepStrictEqual(itfPicks(third), { next: "Yellow", wait: undefined }), "itfPicks did not turn None into undefined");
  assert(isDeepStrictEqual(parseItfTrace(JSON.parse(text)), trace), "a parsed object and its JSON text decode differently");
  const rejects = (input: unknown, fragment: string): boolean => {
    try {
      decodeItfValue(input);
      return false;
    } catch (error) {
      return error instanceof ItfError && error.message.includes(fragment);
    }
  };
  assert(rejects({ "#unserializable": "fn" }, "unserializable"), "#unserializable was not an error");
  assert(rejects({ a: { "#set": [1, { "#unserializable": "x" }] } }, "$.a.#set[1]"), "an ITF error lost its path");
  assert(rejects({ "#bigint": "12x" }, "#bigint"), "a malformed #bigint was accepted");
  assert(rejects({ "#weird": 1 }, "unknown ITF key"), "an unknown # key was accepted");
  assert(rejects(1.5, "not an integer"), "a fraction was accepted as an ITF value");
  assert(rejects(null, "null"), "null was accepted as an ITF value");
  let missingVar = false;
  try {
    parseItfTrace({ vars: ["x"], states: [{}] });
  } catch (error) {
    missingVar = error instanceof ItfError && error.message.includes("missing variable x");
  }
  assert(missingVar, "a state without a declared variable was accepted");
}

function encodingChecks(): void {
  // Ruby must read the store's UTF-8 files as UTF-8 even when the caller has no UTF-8 locale.
  const probe = runCommand("ruby", ["-e", "print Encoding.default_external.name"], { env: { LANG: "", LC_ALL: "", LC_CTYPE: "" } });
  assert(probe.exitCode === 0 && probe.stdout.trim() === "UTF-8", `ruby reads files as ${probe.stdout.trim() || probe.stderr.trim()}, not UTF-8`);
}

async function main(): Promise<void> {
  for (const file of ["web/index.html", "web/styles.css", "web/app.js", "web/assets/ci-common/tokens.css", "web/assets/ci-common/logo-mark.svg"]) assert(fileExists(file), `missing asset: ${file}`);
  assert(readText("web/index.html").includes("CI Agent Sync"), "wizard name is stale");
  assert(readText("web/styles.css").includes("--primary"), "wizard does not use CI-Common semantic tokens");
  const validation = runCommand("node", ["--experimental-strip-types", "--no-warnings", join(ROOT, "src", "cli.ts"), "check"], { cwd: ROOT, timeoutMs: 60_000 });
  assert(validation.exitCode === 0, `store validation failed: ${validation.stderr || validation.stdout}`);

  const timeoutProbe = await runCommandAsync(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { cwd: ROOT, timeoutMs: 100 });
  assert(timeoutProbe.timedOut && timeoutProbe.exitCode === null && timeoutProbe.errorCode === "ETIMEDOUT", "async command timeout did not fail closed");
  const outputProbe = await runCommandAsync(process.execPath, ["-e", "process.stdout.write('x'.repeat(70000))"], { cwd: ROOT, timeoutMs: 2_000, maxBuffer: 1_024 });
  assert(outputProbe.outputTruncated && outputProbe.exitCode === null && outputProbe.errorCode === "MAX_BUFFER", "async command output cap did not fail closed");
  kvmChecks();
  itfChecks();
  encodingChecks();
  assert(!safeDetail('{"apiKey":"not-for-output"}').includes("not-for-output"), "structured secret detail was not redacted");
  assert((redactSecrets({ apiKey: "not-for-output", status: "ok" }) as any).apiKey === "<redacted>", "structured payload secret was not redacted");
  const tailnet = summarizeTailscaleStatus({
    Self: { HostName: "laptop", DNSName: "laptop.example.ts.net.", Online: true, TailscaleIPs: ["100.64.0.1"] },
    Peer: { one: { HostName: "core-1", Online: true, OS: "linux", TailscaleIPs: ["100.64.0.2"] }, two: { HostName: "retired", Online: false, OS: "linux", TailscaleIPs: [] } },
  });
  assert(tailnet.available && tailnet.summary.online === 2 && tailnet.summary.offline === 1, "Tailscale evidence summary is incorrect");

  const child = spawn("node", ["--experimental-strip-types", "--no-warnings", join(ROOT, "src", "cli.ts"), "atlas", "--port", "0"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const started = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("TypeScript wizard did not start within 5 seconds")), 5_000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  try {
    const port = await started;
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert(health.status === 200, `health status ${health.status}`);
    const overview = await fetch(`http://127.0.0.1:${port}/api/overview`);
    const payload = await overview.json() as any;
    assert(overview.status === 200 && payload.app?.name === "CI Agent Sync", "overview payload is stale");
    const tokens = await fetch(`http://127.0.0.1:${port}/assets/ci-common/tokens.css`);
    assert(tokens.status === 200 && (await tokens.text()).includes("--background"), "vendored token asset is not served");
    const guarded = await fetch(`http://127.0.0.1:${port}/api/action/backup`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert(guarded.status === 400, "backup action lost its confirmation guard");
    const unknownCheck = await fetch(`http://127.0.0.1:${port}/api/check/unknown`);
    const unknownPayload = await unknownCheck.json() as any;
    assert(unknownCheck.status === 503 && unknownPayload.status === "error", "failed checks did not return a failing HTTP status");
    const oversized = await fetch(`http://127.0.0.1:${port}/api/action/backup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true, padding: "x".repeat(70_000) }) });
    assert(oversized.status === 413, "action body limit did not fail closed");
  } finally {
    child.kill("SIGTERM");
  }
  console.log("CI Agent Sync TypeScript checks passed");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
