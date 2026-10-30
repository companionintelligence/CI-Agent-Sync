/**
 * Capture stage for CI Agent Sync.
 *
 * `ci-video capture` drives the REAL setup wizard (web/index.html + web/app.js,
 * served by `./bin/agent-atlas`) — see stage.sh, which runs it on loopback with
 * an empty throwaway HOME. There is no login wall, no database and no network
 * dependency: the wizard reads this repo's own YAML and serves a static page,
 * so the screens are the same on every run.
 *
 * Determinism notes, read out of web/app.ts rather than guessed:
 *  - The wizard is a single page. Steps are `.wizard-step[data-step=N]`, moved by
 *    `#next-button`; every shot therefore loads `/` and clicks forward N times.
 *    The state lives in memory, so each shot starts clean at step 1.
 *  - The theme comes from `colorScheme` below (the wizard follows the system
 *    theme unless localStorage says otherwise, and a fresh context has none).
 *  - Nothing on screen carries a clock or a count that moves: harness and
 *    profile lists come from YAML. The one volatile surface is the backup
 *    PREVIEW (timestamped absolute path), which no shot opens.
 */
export default {
  baseURL: process.env.APP_URL ?? "http://127.0.0.1:8787",

  colorScheme: "dark",
  locale: "en-US",
  timezoneId: "UTC",
  fixedTime: "2026-10-29T15:04:00Z",

  async onContext(context) {
    // The wizard loads its own bundled fonts and brand assets from /assets.
    // Anything off-box failing here would mean an unstyled, dishonest capture.
    context.on("requestfailed", (req) => {
      if (!/127\.0\.0\.1|localhost/.test(req.url())) {
        console.warn(`  ! external asset failed: ${req.url()}`);
      }
    });
  },
};
