import { spawn } from "node:child_process";
import { join } from "node:path";
import { ROOT, fileExists, readText, redactSecrets, runCommand, runCommandAsync, safeDetail } from "./core.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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
  assert(!safeDetail('{"apiKey":"not-for-output"}').includes("not-for-output"), "structured secret detail was not redacted");
  assert((redactSecrets({ apiKey: "not-for-output", status: "ok" }) as any).apiKey === "<redacted>", "structured payload secret was not redacted");

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
