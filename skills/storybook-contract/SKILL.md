---
name: storybook-contract
description: >-
  Load when adding or changing a UI component in a React and Vite app, writing stories, play
  functions or accessibility checks, setting up Storybook tests, or when a registry entry has
  tool = "storybook". Covers Storybook 10.6.9 with the Vitest addon, play functions, axe at error,
  telemetry off, pinning after init, removing Chromatic, the security floor, and what changes in 11.
---

# Storybook contracts

Each story is one state of a component. With `@storybook/addon-vitest` every story becomes a Vitest
browser test in headless Chromium: a story is a render check, its play function is an interaction
test, and `@storybook/addon-a11y` runs axe on it. Only the states you write are checked, so write a
story for every state the component has.

## When to use

Use it for component contracts in React and Vite apps: every state a story, a play function per
interaction, accessibility at `error`.

Do not use it for backend or protocol rules (`quint-spec`), behaviour across pages over time
(`bombadil-property`) or WebGL canvas content, which DOM queries and axe cannot see (pixel readback
only). The Vitest addon needs a Vite-based framework.

## Versions

- Pin `storybook` and every `@storybook/*` package at 10.6.9. The floor is 10.6.2: earlier releases
  carry GHSA-f2ph-cmg5-wxc8 (critical) and GHSA-px85-f4q5-jh77 (high). The same advisory sets floors
  for Vite (6.4.2, 7.3.2 or 8.0.5) and Vitest (3.2.7 or 4.1.10).
- Storybook 10 needs Node 20.19+ or 22.12+. The Vitest addon peers on Vitest 4 or 5.
- Stay on 10.6.x until 11.0 is generally available (see the end).

## Set up (telemetry off first)

Storybook sends a `boot` telemetry event before it reads `main.ts`, so the `disableTelemetry` option
there cannot stop it. Set the environment variable first:

```sh
export STORYBOOK_DISABLE_TELEMETRY=1
npx create-storybook@10.6.9 --yes --features docs test a11y --no-dev --disable-telemetry --package-manager npm
# or, with Storybook already present:
npx storybook add @storybook/addon-vitest@10.6.9
npx storybook add @storybook/addon-a11y@10.6.9
npx playwright install --only-shell chromium   # the headless shell is enough for story tests
```

Then clean up what init did:

1. Pin. Init writes `latest` for `vitest`, `@vitest/browser-playwright`, `@vitest/coverage-v8`,
   `playwright` and `@chromatic-com/storybook`, and caret ranges for the Storybook packages. Read the
   resolved versions (`npm ls --depth=0`) and reinstall each with `npm install -D --save-exact
   <name>@<version>`.
2. Remove Chromatic, a hosted visual-testing client that init adds even when you did not ask:
   `npm uninstall @chromatic-com/storybook` and delete it from `addons` in `.storybook/main.ts`.
3. Set `core: { disableTelemetry: true }` in `.storybook/main.ts`, and keep
   `STORYBOOK_DISABLE_TELEMETRY=1` in every script and CI job, for example
   `"test-storybook": "STORYBOOK_DISABLE_TELEMETRY=1 vitest --project=storybook --run"`.
4. Delete `debug-storybook.log`; init writes it when it detects an agent.
5. Use the same Playwright version locally and in CI (for example the image
   `mcr.microsoft.com/playwright:v<installed version>-noble`).

## Write the contract

```tsx
// src/components/StatusBadge/StatusBadge.stories.tsx
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { StatusBadge } from './StatusBadge';

const meta = {
  title: 'Status/StatusBadge',
  component: StatusBadge,
  parameters: { a11y: { test: 'error' } },   // any axe violation fails the run
  args: { status: 'online', onRetry: fn() },
} satisfies Meta<typeof StatusBadge>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Online: Story = {
  args: { status: 'online' },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveAccessibleName('Service status: Online');
    await expect(canvas.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  },
};

export const Offline: Story = {
  args: { status: 'offline' },
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Retry' }));
    await expect(args.onRetry).toHaveBeenCalledTimes(1);
  },
};
// Degraded and CustomLabel follow the same pattern: one story per state.
```

- Query by role and accessible name, as a user would. A failure lists the roles on the page and a
  DOM dump.
- `satisfies Meta<typeof C>` makes `tsc` check story args against the props.
- `parameters.a11y.test` is `'off'`, `'todo'` or `'error'`. `'todo'` gives no output at all in CI, so a
  "todo now, error later" ratchet gives no signal: use `'error'` on new and changed stories. Never
  lower the level to make a test pass. axe finds only part of the WCAG issues; it does not replace a
  review.

## Check

```sh
STORYBOOK_DISABLE_TELEMETRY=1 npx vitest --project=storybook --run      # the test-storybook script
npx tsc -p tsconfig.app.json --noEmit                                   # story args against props
STORYBOOK_DISABLE_TELEMETRY=1 npx vitest --project=storybook --run --coverage --coverage.include='src/components/**'
STORYBOOK_DISABLE_TELEMETRY=1 npx storybook build --quiet --disable-telemetry
```

No running Storybook is needed for tests. The first run is slow (about 50 seconds cold on a laptop);
warm runs of a few stories take seconds.

ci-local runs every entry's `check` on pre-push, so an entry's `check` runs the stories it covers,
not the whole suite: `vitest --project=storybook --run src/components/StatusBadge` ran that
component's 4 stories in 12 seconds in the trial. Run the full suite, coverage and the build by
dispatch or nightly. `--changed <ref>` also works with the storybook project and runs only the
stories a change reaches. Use it in the local loop, not as `check`: with nothing changed it runs no
story and exits 0.

## Traps

- In 10.6.x the failure location can be 3 to 9 lines off and point into a neighbouring story. Find
  the failing assertion by its message, not the line number. 11.0 reports the right line.
- `storybook dev` and the `@storybook/addon-mcp` endpoint (`http://127.0.0.1:6006/mcp`) must stay on
  loopback. Host checks do not protect a dev server from other machines on the network. To share
  components, share a built Storybook.
- The built `manifests/components.json` embeds absolute paths from the build machine. Check it before
  you publish a build.
- Visual regression: do not add Chromatic. Vitest's `toMatchScreenshot` works from a setup file but
  Storybook does not document it, baselines are named per platform, and the first run fails by
  design while it writes them.
- A React Three Fiber canvas always renders its fallback inside `<canvas>`; assert on pixels or
  renderer callbacks, not on DOM inside the canvas.

## Storybook 11 (release candidate)

Do not move before it is generally available. When you do: it needs Node 22.12, TypeScript 5.9,
Vite 6.3 and Vitest 4; it removes Yarn PnP support, the Jest test-runner and `storybook dev
--no-open`; on TypeScript 7.0 docgen needs TypeScript 6 installed beside it. `storybook upgrade` runs
an unpinned `npx skills@latest add storybookjs/skills#<version>` and writes a managed block into
AGENTS.md and CLAUDE.md. Where CI-Agent-Sync owns agent files, remove both markers; upgrade does not
add the block back. 11 adds `npx storybook tools test run --changed <ref>`, its MCP tool set differs
from 10.6's, and its dev server no longer serves the manifest JSON.

## Register it

```toml
[[spec]]
id = "status-badge"
title = "StatusBadge: every status has a story, Retry only when offline, no axe violations"
kind = "component"
tool = "storybook"
status = "checked"
artefacts = ["src/components/StatusBadge/StatusBadge.stories.tsx"]
covers = ["src/components/StatusBadge/**"]
requires = ["node", "storybook"]
check = ["npm", "run", "--silent", "spec:status-badge"]
properties = ["Online", "Degraded", "Offline", "CustomLabel"]
notes = "a11y.test is error on every story. Canvas content is not checked."
```

Here `"spec:status-badge": "STORYBOOK_DISABLE_TELEMETRY=1 vitest --project=storybook --run src/components/StatusBadge"`.
The `chromium` toolchain is the system Chrome that Bombadil drives; the Vitest addon brings its own
Playwright Chromium, so a story entry does not require it.

## PR verification block

```markdown
| Entry | Tool | Command | Commit | Result |
|---|---|---|---|---|
| status-badge | storybook 10.6.9, vitest <pinned>, playwright <pinned> | `npm run spec:status-badge` | abc1234 | 4 stories pass; 0 axe violations |
```

## References

- AI docs: https://storybook.js.org/llms.txt and https://storybook.js.org/llms-full.txt. Every docs
  page has a Markdown version: add `.md` to its URL, for example
  https://storybook.js.org/docs/writing-tests/integrations/vitest-addon.md.
- Upstream skills exist only for 11.0: the same text ships MIT-licensed in storybookjs/storybook under
  `code/lib/claude-plugin/skills` (tag v11.0.0-rc.1, commit 7bfb4ca). The storybookjs/skills repository
  has no licence: link to it, never copy from it.
- Registry and loop: `spec-first`. Flows across pages: `bombadil-property`.
