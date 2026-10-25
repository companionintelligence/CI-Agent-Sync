const state = {
  step: 1,
  overview: null,
  selectedAgents: new Set(),
  profile: "ceo",
  rendered: false,
  backup: null,
  theme: "system",
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const stepLabels = ["Start", "Vault", "Agents", "Profile", "Backup", "Ready"];

function systemPrefersDark() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function applyTheme(theme) {
  state.theme = theme;
  const dark = theme === "dark" || (theme === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.classList.toggle("light", !dark);
  const toggle = $("#theme-toggle");
  if (!toggle) return;
  const label = theme.charAt(0).toUpperCase() + theme.slice(1);
  toggle.setAttribute("aria-label", `Use ${theme} theme`);
  toggle.setAttribute("title", `Theme: ${label}. Click to change.`);
  text(".theme-label", label);
}

function initTheme() {
  const saved = window.localStorage?.getItem("ci-agent-sync-theme");
  applyTheme(saved === "light" || saved === "dark" ? saved : "system");
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if (state.theme === "system") applyTheme("system");
  });
}

function make(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}

function text(selector, value) {
  const element = typeof selector === "string" ? $(selector) : selector;
  if (element) element.textContent = value ?? "";
}

function copyText(value, feedback = "#render-status") {
  navigator.clipboard.writeText(value).then(() => {
    text(feedback, "Copied.");
    window.setTimeout(() => text(feedback, ""), 2200);
  }).catch(() => text(feedback, "Select the command manually."));
}

function setStep(step) {
  state.step = Math.max(1, Math.min(6, step));
  $$('[data-step]').forEach((section) => {
    section.hidden = Number(section.dataset.step) !== state.step;
  });
  text("#step-number", state.step);
  text("#step-label", stepLabels[state.step - 1]);
  $("#progress-bar").style.width = `${(state.step / 6) * 100}%`;
  const back = $("#back-button");
  const next = $("#next-button");
  back.disabled = state.step === 1;
  next.textContent = state.step === 1 ? "Start setup" : state.step === 6 ? "Done" : state.step === 5 ? "Finish" : "Continue";
  next.disabled = state.step === 6;
  if (state.step === 6) renderReadySummary();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderAgents(items) {
  const list = $("#harness-options");
  list.replaceChildren();
  items.forEach((item) => {
    state.selectedAgents.add(item.id);
    const label = make("label", "option-row");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = true;
    input.dataset.agent = item.id;
    input.addEventListener("change", () => {
      if (input.checked) state.selectedAgents.add(item.id);
      else state.selectedAgents.delete(item.id);
      updateAgentCount();
    });
    const mark = make("span", "fake-checkbox");
    const detail = make("span");
    detail.append(make("span", "option-name", item.name), make("span", "option-detail", (item.capabilities || []).join(" · ")));
    label.append(make("span"), input, mark, detail);
    list.append(label);
  });
  updateAgentCount();
}

function updateAgentCount() {
  const total = state.overview?.harnesses?.length || 0;
  text("#agent-count", `${state.selectedAgents.size} of ${total} selected`);
  $("#select-all").textContent = state.selectedAgents.size === total ? "Clear all" : "Select all";
}

function renderProfiles(items) {
  const list = $("#profile-options");
  list.replaceChildren();
  items.forEach((item) => {
    const label = make("label", "profile-row");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "profile";
    input.value = item.id;
    input.checked = item.id === state.profile;
    input.addEventListener("change", () => {
      state.profile = item.id;
      renderProfilePlan();
    });
    const radio = make("span", "radio-mark");
    const detail = make("span");
    detail.append(
      make("span", "profile-name", item.name),
      make("span", "profile-detail", `${item.bundles.join(" · ")} / ${item.default_chain || "default"}`),
    );
    label.append(input, radio, detail);
    list.append(label);
  });
  renderProfilePlan();
}

function currentProfile() {
  return state.overview?.profiles?.find((profile) => profile.id === state.profile) || { name: "CEO", bundles: ["core"] };
}

function renderProfilePlan() {
  const profile = currentProfile();
  const plan = $("#config-plan");
  plan.replaceChildren();
  plan.append(make("span", "plan-label", "Portable plan"));
  plan.append(make("strong", null, profile.name));
  plan.append(make("p", null, `Bundles: ${profile.bundles.join(", ")}`));
  plan.append(make("p", null, `Agents selected: ${state.selectedAgents.size}`));
  const code = make("code", null, `./bin/agentctl profile show ${profile.id} --json\n./bin/agentctl render --agent all`);
  plan.append(code);
}

function renderReadySummary() {
  const summary = $("#ready-summary");
  summary.replaceChildren();
  const profile = currentProfile();
  const row = (label, value) => {
    const item = make("div");
    item.append(make("dt", null, label), make("dd", null, value));
    return item;
  };
  summary.append(row("Profile", profile.name), row("Agents", `${state.selectedAgents.size} selected`), row("Backup", state.backup || "Not created in this run"));
}

async function request(url, options = {}) {
  const response = await fetch(url, { headers: { Accept: "application/json", "Content-Type": "application/json" }, ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || `Request failed (${response.status})`);
  return payload;
}

async function runAction(url, statusSelector, successText) {
  const button = $(url.includes("backup") ? "#backup-button" : "#render-button");
  button.disabled = true;
  text(statusSelector, "Working…");
  try {
    const result = await request(url, { method: "POST", body: JSON.stringify({ confirm: true }) });
    if (result.status !== "ok") throw new Error(result.message || "Action did not complete");
    if (url.includes("backup")) state.backup = result.message || "Created";
    else state.rendered = true;
    text(statusSelector, successText);
    if (url.includes("backup")) renderReadySummary();
  } catch (error) {
    text(statusSelector, error.message);
  } finally {
    button.disabled = false;
  }
}

async function previewBackup() {
  const panel = $("#backup-plan");
  panel.hidden = false;
  panel.textContent = "Reading available agent configs…";
  try {
    const result = await request("/api/check/backup-plan");
    panel.textContent = result.data ? JSON.stringify(result.data, null, 2) : (result.message || "No plan returned");
  } catch (error) {
    panel.textContent = error.message;
  }
}

function wireEvents() {
  $("#theme-toggle").addEventListener("click", () => {
    const next = state.theme === "system" ? "light" : state.theme === "light" ? "dark" : "system";
    window.localStorage?.setItem("ci-agent-sync-theme", next);
    applyTheme(next);
  });
  $("#next-button").addEventListener("click", () => {
    if (state.step < 6) setStep(state.step + 1);
  });
  $("#back-button").addEventListener("click", () => {
    if (state.step > 1) setStep(state.step - 1);
  });
  $("#select-all").addEventListener("click", () => {
    const inputs = $$('[data-agent]', $("#harness-options"));
    const shouldSelect = state.selectedAgents.size !== inputs.length;
    inputs.forEach((input) => {
      input.checked = shouldSelect;
      if (shouldSelect) state.selectedAgents.add(input.dataset.agent);
      else state.selectedAgents.delete(input.dataset.agent);
    });
    updateAgentCount();
  });
  $$('[data-copy]').forEach((button) => button.addEventListener("click", () => copyText(button.dataset.copy.replaceAll("\\n", "\n"))));
  $("#render-button").addEventListener("click", () => runAction("/api/action/render", "#render-status", "Portable artifacts generated under local/rendered."));
  $("#backup-plan-button").addEventListener("click", previewBackup);
  $("#backup-button").addEventListener("click", () => runAction("/api/action/backup", "#backup-status", "Redacted backup created."));
  $("#start-over").addEventListener("click", () => {
    state.step = 1;
    state.rendered = false;
    state.backup = null;
    setStep(1);
  });
}

initTheme();
wireEvents();
request("/api/overview")
  .then((payload) => {
    state.overview = payload;
    renderAgents(payload.harnesses || []);
    renderProfiles(payload.profiles || []);
    $("#loading-banner").classList.add("loaded");
  })
  .catch((error) => {
    text("#loading-banner", `Could not read the store: ${error.message}`);
  });
