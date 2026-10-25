const state = { overview: null };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function text(element, value) {
  if (element) element.textContent = value ?? "";
}

function make(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}

function tagList(values, className = "capability-tags") {
  const list = make("div", className);
  (values || []).forEach((value) => list.append(make("span", null, value)));
  return list;
}

function renderHarnesses(items) {
  const list = $("#harness-list");
  list.replaceChildren();
  items.forEach((item) => {
    const row = make("article", "harness-row");
    const name = make("div", "harness-name");
    name.append(make("span", "status-dot"), make("span", null, item.name));
    row.append(name, tagList(item.capabilities));
    row.append(make("span", "smoke-tag", item.smoke ? `smoke: ${item.smoke}` : "native app"));
    list.append(row);
  });
}

function renderProviders(items) {
  const grid = $("#provider-grid");
  grid.replaceChildren();
  items.forEach((item) => {
    const card = make("article", "provider-card");
    const top = make("div", "provider-top");
    top.append(make("h3", null, item.name), make("span", "provider-kind", item.class));
    const meta = make("div", "provider-meta");
    const env = make("span");
    env.append(make("b", null, "secret slot "), document.createTextNode(item.env || "native auth"));
    const endpoint = make("span");
    endpoint.append(make("b", null, "route "), document.createTextNode(item.endpoint_env || "local / native"));
    meta.append(env, endpoint, tagList(item.clients.slice(0, 5)));
    card.append(top, meta);
    grid.append(card);
  });
}

function renderBundles(items) {
  const list = $("#bundle-list");
  list.replaceChildren();
  items.forEach((item, index) => {
    const row = make("article", "bundle-row");
    row.append(make("span", "bundle-number", String(index + 1).padStart(2, "0")));
    const body = make("div");
    const title = make("h3", null, item.name);
    const description = make("p", null, item.description || "Reviewed capability set");
    const tags = tagList(item.servers, "bundle-tags");
    if (item.high_risk) tags.append(make("span", "bundle-risk", "approval required"));
    body.append(title, description, tags);
    row.append(body);
    list.append(row);
  });
}

function renderOverview(payload) {
  state.overview = payload;
  const counts = payload.counts || {};
  text($("#app-version"), payload.app?.version);
  text($("#runtime-label"), `${counts.harnesses || 0} harnesses mapped`);
  text($("#count-harnesses"), counts.harnesses);
  text($("#count-providers"), counts.providers);
  text($("#count-mcps"), counts.mcp_servers);
  text($("#count-bundles"), counts.bundles);
  text($("#signal-summary"), `${counts.marketplace_harnesses || 0} Marketplace bridges`);
  renderHarnesses(payload.harnesses || []);
  renderProviders(payload.providers || []);
  renderBundles(payload.bundles || []);
}

function showResult(kind, result) {
  const panel = $("#result-panel");
  const status = $("#result-status");
  panel.hidden = false;
  status.className = `result-status ${result.status === "error" ? "error" : ""}`;
  text(status, result.status === "ok" ? "PASS" : result.status.toUpperCase());
  text($("#result-title"), `${kind} / read-only evidence`);
  const output = result.data ? JSON.stringify(result.data, null, 2) : (result.message || "No output");
  text($("#result-output"), output.slice(0, 40000));
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function runCheck(kind, sourceButton) {
  const panel = $("#result-panel");
  const status = $("#result-status");
  panel.hidden = false;
  status.className = "result-status working";
  text(status, "RUNNING");
  text($("#result-title"), `${kind} / collecting evidence`);
  text($("#result-output"), "The local read-only probe is running…");
  if (sourceButton) sourceButton.disabled = true;
  try {
    const response = await fetch(`/api/check/${encodeURIComponent(kind)}`, { headers: { Accept: "application/json" } });
    const result = await response.json();
    showResult(kind, result);
  } catch (error) {
    showResult(kind, { status: "error", message: error.message });
  } finally {
    if (sourceButton) sourceButton.disabled = false;
  }
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    text($("#copy-feedback"), "Copied to clipboard.");
  } catch (_error) {
    text($("#copy-feedback"), "Clipboard access is unavailable; select the command manually.");
  }
  window.setTimeout(() => text($("#copy-feedback"), ""), 3000);
}

$$('[data-copy="setup"]').forEach((button) => button.addEventListener("click", () => copyText([
  "git clone https://github.com/mrhegemon/agent-configs.git",
  "cd agent-configs",
  "./bin/agentctl credentials op setup",
  "./bin/agentctl credentials op import",
  "./bin/agent-atlas --open",
].join("\n"))));

$$("[data-copy-text]").forEach((button) => button.addEventListener("click", () => copyText(button.dataset.copyText)));
$$('[data-check]').forEach((button) => button.addEventListener("click", () => runCheck(button.dataset.check, button)));
$("#close-result")?.addEventListener("click", () => { $("#result-panel").hidden = true; });

fetch("/api/overview", { headers: { Accept: "application/json" } })
  .then((response) => response.json())
  .then(renderOverview)
  .catch((error) => {
    text($("#runtime-label"), "store unavailable");
    text($("#signal-summary"), "start the local server");
    $$(".loading-row").forEach((row) => text(row, `Could not read the store: ${error.message}`));
  });
