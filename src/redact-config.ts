// Redaction for the configuration the store copies off a machine: backups under
// local/backups and snapshots under agents/, which are tracked files. It works on the
// parsed structure, so a secret is found by where it sits as well as by its shape, and it
// fails closed: a file it cannot parse is not copied at all.
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { HOME, SENSITIVE_KEY, redactText } from "./core.ts";

/** "json" covers JSONC. */
export type ConfigKind = "json" | "yaml" | "toml";

const HIDDEN = "<redacted>";
// Environment-style names such as OPENAI_KEY, SLACK_BOT_KEY, GITHUB_PAT and DB_PASS.
const ENV_SECRET_NAME = /(?:^|_)(?:KEY|PAT|PASS|PWD)$/;
// Blocks whose values are credentials often enough that none is copied.
const VALUE_BLOCKS = new Set(["env", "environment", "headers", "http_headers"]);
// Command-line options whose next argument is the secret.
const SECRET_FLAG = /^--?(?:[a-z0-9]+-)*(?:token|api-?key|key|secret|password|passwd|pass|pwd|pat|credential|auth|bearer)$/i;
const HEADER_FLAG = /^(?:-H|--header)$/;
// The name of a variable or of a vault item is not its value, so it stays readable.
const REFERENCE = /^(?:(?:Bearer|Basic|token)\s+)?(?:\$\{[^{}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|op:\/\/.*)?$/;
const NAMES_A_VARIABLE = /(?:_env_var|_env_key|EnvVar|EnvKey)$/;
const MAIL_ACCOUNT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

const keepReference = (value: string): string => (REFERENCE.test(value) ? value : HIDDEN);

function hideHeader(header: string): string {
  const colon = header.indexOf(":");
  return colon < 0 ? keepReference(header) : `${header.slice(0, colon)}: ${keepReference(header.slice(colon + 1).trim())}`;
}

function hideAssignment(entry: string): string {
  const equals = entry.indexOf("=");
  return equals < 0 ? keepReference(entry) : `${entry.slice(0, equals)}=${keepReference(entry.slice(equals + 1))}`;
}

function scrubList(list: unknown[], key: string, inBlock: boolean): unknown[] {
  // env as a list holds NAME=value entries.
  if (VALUE_BLOCKS.has(key.toLowerCase())) return list.map((item) => (typeof item === "string" ? hideAssignment(item) : scrub(item, key, true)));
  let next: "value" | "header" | null = null;
  return list.map((item) => {
    const pending = next;
    next = null;
    if (typeof item !== "string") return scrub(item, key, inBlock);
    if (HEADER_FLAG.test(item)) next = "header";
    else if (SECRET_FLAG.test(item)) next = "value";
    if (pending === "value") return keepReference(item);
    if (pending === "header") return hideHeader(item);
    const joined = /^(--?[A-Za-z0-9-]+)=([\s\S]*)$/.exec(item);
    if (joined && SECRET_FLAG.test(joined[1])) return `${joined[1]}=${keepReference(joined[2])}`;
    if (joined && HEADER_FLAG.test(joined[1])) return `${joined[1]}=${hideHeader(joined[2])}`;
    return scrub(item, key, inBlock);
  });
}

function scrub(value: unknown, key: string, inBlock: boolean): unknown {
  if (typeof value === "string" && NAMES_A_VARIABLE.test(key) && /^[A-Z_][A-Z0-9_]*$/.test(value)) return value;
  if (key && (SENSITIVE_KEY.test(key) || ENV_SECRET_NAME.test(key))) return typeof value === "string" ? keepReference(value) : HIDDEN;
  if (Array.isArray(value)) return scrubList(value, key, inBlock);
  if (value instanceof Date) return value;
  if (value && typeof value === "object") {
    const block = inBlock || VALUE_BLOCKS.has(key.toLowerCase());
    return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, scrub(child, name, block)]));
  }
  if (typeof value !== "string") return value;
  if (inBlock) return keepReference(value);
  const text = redactText(value);
  return text.length > 300 ? `<long string ${text.length} chars>` : text;
}

// Per-folder tables name local projects, personal and client ones included, and the
// auto-mode notes describe this machine's organisation and internal services.
function withoutLocalTables(document: unknown): unknown {
  if (!document || typeof document !== "object" || Array.isArray(document)) return document;
  const { projects: _projects, ...rest } = document as Record<string, any>;
  if (rest.desktop?.["open-in-target-preferences"]?.perPath) delete rest.desktop["open-in-target-preferences"].perPath;
  if (rest.autoMode && typeof rest.autoMode === "object" && "environment" in rest.autoMode) {
    rest.autoMode = { ...rest.autoMode, environment: ["<redacted: describe your own environment here>"] };
  }
  return rest;
}

function anonymize(text: string, home: string): string {
  const placeholder = home.startsWith("/Users/") ? "/Users/<user>" : "<home>";
  const homeless = home.length > 1 ? text.split(home).join(placeholder) : text;
  const mailless = homeless.replace(MAIL_ACCOUNT, "<account-email>");
  const suffix = process.env.CI_TAILNET_DNS_SUFFIX || "";
  return suffix ? mailless.split(suffix).join("<tailnet>") : mailless;
}

/** JSONC to JSON: comments and trailing commas removed, strings left as they are. */
export function stripJsonc(text: string): string {
  const tokens = (text.replace(/^﻿/, "").match(/"(?:\\.|[^"\\\n])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[,\]}]|[^"/,\]}]+|[\s\S]/g) ?? [])
    .filter((token) => !token.startsWith("//") && !token.startsWith("/*"));
  return tokens.filter((token, index) => {
    if (token !== ",") return true;
    let later = index + 1;
    while (later < tokens.length && tokens[later].trim() === "") later += 1;
    return tokens[later] !== "}" && tokens[later] !== "]";
  }).join("");
}

export function configKind(path: string): ConfigKind {
  return /\.toml$/i.test(path) ? "toml" : /\.ya?ml$/i.test(path) ? "yaml" : "json";
}

/**
 * The redacted form of one configuration file. `select` narrows the document first, for a
 * file where only one part is configuration. Throws, without quoting the file, when the
 * text does not parse.
 */
export function redactConfigText(raw: string, kind: ConfigKind, options: { home?: string; select?: (document: any) => unknown } = {}): string {
  // Apps leave empty config files; there is nothing in one to parse or hide.
  if (!raw.trim()) return "";
  let document: unknown;
  try {
    document = kind === "toml" ? parseToml(raw) : kind === "yaml" ? parseYaml(raw) : JSON.parse(stripJsonc(raw));
  } catch {
    // A parser's own message quotes the line it stopped at, which may hold the secret.
    throw new Error(`could not be parsed as ${kind.toUpperCase()}, so it was not copied`);
  }
  const clean = scrub(withoutLocalTables(options.select ? options.select(document) : document), "", false);
  const text = kind === "toml" ? stringifyToml(clean as Record<string, unknown>) : kind === "yaml" ? stringifyYaml(clean) : JSON.stringify(clean, null, 2);
  return `${anonymize(text, options.home ?? HOME).replace(/\n*$/, "")}\n`;
}
