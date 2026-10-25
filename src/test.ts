import { spawn } from "node:child_process";
import { join } from "node:path";
import { ROOT, fileExists, readText, runCommand } from "./core.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  for (const file of ["web/index.html", "web/styles.css", "web/app.js", "web/assets/ci-common/tokens.css", "web/assets/ci-common/logo-mark.svg"]) assert(fileExists(file), `missing asset: ${file}`);
  assert(readText("web/index.html").includes("CI Agent Sync"), "wizard name is stale");
  assert(readText("web/styles.css").includes("--primary"), "wizard does not use CI-Common semantic tokens");
  const validation = runCommand("node", ["--experimental-strip-types", "--no-warnings", join(ROOT, "src", "cli.ts"), "check"], { cwd: ROOT, timeoutMs: 60_000 });
  assert(validation.exitCode === 0, `store validation failed: ${validation.stderr || validation.stdout}`);

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
  } finally {
    child.kill("SIGTERM");
  }
  console.log("CI Agent Sync TypeScript checks passed");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
