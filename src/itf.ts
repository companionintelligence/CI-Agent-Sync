// A small decoder for Quint's ITF traces (the Informal Trace Format, Apalache ADR-015).
//
// `quint run --mbt --out-itf` writes one JSON trace per run. A TypeScript test replays a
// trace against the implementation: read each state, take the action Quint chose
// (itfAction) and its nondeterministic picks (itfPicks), apply the same action to the
// code, and compare. There is no official TypeScript connector, so this stays small and
// strict: anything it does not understand is an error, not a guess.
//
// Values map as follows: #bigint to bigint, #set to Set, #map to Map, #tup to an array,
// JSON arrays (Quint lists) to arrays, and records to plain objects. Quint variants stay
// records of the form { tag, value }. #unserializable is an error.

export type ItfValue = boolean | string | number | bigint | ItfValue[] | Set<ItfValue> | Map<ItfValue, ItfValue> | { [field: string]: ItfValue };
export type ItfState = Record<string, ItfValue>;
export type ItfTrace = {
  /** Variable names in order, without the duplicates `--mbt` writes. */
  readonly vars: string[];
  readonly states: ItfState[];
  /** The trace's #meta object, as written. */
  readonly meta: Record<string, unknown>;
  readonly params?: string[];
  /** Index of the state a lasso trace loops back to. */
  readonly loop?: number;
};

export const ACTION_TAKEN = "mbt::actionTaken";
export const NONDET_PICKS = "mbt::nondetPicks";

export class ItfError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ItfError";
    this.path = path;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Set) && !(value instanceof Map);

function only(value: Record<string, unknown>, key: string, path: string): unknown {
  const keys = Object.keys(value);
  if (keys.length !== 1) throw new ItfError(path, `${key} must be the only key, found ${keys.join(", ")}`);
  return value[key];
}

/** Decode one ITF value. Already-decoded values pass through unchanged. */
export function decodeItfValue(value: unknown, path = "$"): ItfValue {
  if (typeof value === "boolean" || typeof value === "string" || typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new ItfError(path, `${value} is not an integer; ITF has no other numbers`);
    return value;
  }
  if (value instanceof Set) return new Set([...value].map((item, index) => decodeItfValue(item, `${path}[${index}]`)));
  if (value instanceof Map) return new Map([...value].map(([key, item], index) => [decodeItfValue(key, `${path}[${index}].key`), decodeItfValue(item, `${path}[${index}].value`)]));
  if (Array.isArray(value)) return value.map((item, index) => decodeItfValue(item, `${path}[${index}]`));
  if (!isRecord(value)) throw new ItfError(path, `unexpected ${value === null ? "null" : typeof value}`);
  if ("#bigint" in value) {
    const digits = only(value, "#bigint", path);
    if (typeof digits !== "string" || !/^-?\d+$/u.test(digits)) throw new ItfError(path, "#bigint must be a string of decimal digits");
    return BigInt(digits);
  }
  if ("#tup" in value) {
    const items = only(value, "#tup", path);
    if (!Array.isArray(items)) throw new ItfError(path, "#tup must be an array");
    return items.map((item, index) => decodeItfValue(item, `${path}.#tup[${index}]`));
  }
  if ("#set" in value) {
    const items = only(value, "#set", path);
    if (!Array.isArray(items)) throw new ItfError(path, "#set must be an array");
    return new Set(items.map((item, index) => decodeItfValue(item, `${path}.#set[${index}]`)));
  }
  if ("#map" in value) {
    const pairs = only(value, "#map", path);
    if (!Array.isArray(pairs)) throw new ItfError(path, "#map must be an array of [key, value] pairs");
    return new Map(
      pairs.map((pair, index) => {
        if (!Array.isArray(pair) || pair.length !== 2) throw new ItfError(`${path}.#map[${index}]`, "each entry must be a [key, value] pair");
        return [decodeItfValue(pair[0], `${path}.#map[${index}][0]`), decodeItfValue(pair[1], `${path}.#map[${index}][1]`)] as [ItfValue, ItfValue];
      }),
    );
  }
  if ("#unserializable" in value) throw new ItfError(path, `unserializable value ${JSON.stringify(value["#unserializable"])}`);
  const out: { [field: string]: ItfValue } = {};
  for (const [field, item] of Object.entries(value)) {
    if (field.startsWith("#")) throw new ItfError(path, `unknown ITF key ${field}`);
    out[field] = decodeItfValue(item, `${path}.${field}`);
  }
  return out;
}

/** Parse an ITF trace from JSON text or an already-parsed object. */
export function parseItfTrace(input: string | unknown): ItfTrace {
  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (error) {
      throw new ItfError("$", `not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!isRecord(raw)) throw new ItfError("$", "a trace must be a JSON object");
  if (!Array.isArray(raw.vars) || !raw.vars.every((name) => typeof name === "string")) throw new ItfError("$.vars", "must be an array of variable names");
  if (!Array.isArray(raw.states)) throw new ItfError("$.states", "must be an array");
  const meta = raw["#meta"] === undefined ? {} : raw["#meta"];
  if (!isRecord(meta)) throw new ItfError("$.#meta", "must be an object");
  const vars = [...new Set(raw.vars as string[])];
  const states = raw.states.map((state, index) => {
    const path = `$.states[${index}]`;
    if (!isRecord(state)) throw new ItfError(path, "a state must be an object");
    const decoded: ItfState = {};
    for (const name of vars) {
      if (!(name in state)) throw new ItfError(path, `missing variable ${name}`);
      decoded[name] = decodeItfValue(state[name], `${path}.${name}`);
    }
    for (const key of Object.keys(state)) {
      if (key !== "#meta" && !vars.includes(key)) throw new ItfError(path, `${key} is not one of the trace's vars`);
    }
    return decoded;
  });
  if (raw.loop !== undefined && (typeof raw.loop !== "number" || !Number.isInteger(raw.loop) || raw.loop < 0 || raw.loop >= states.length)) {
    throw new ItfError("$.loop", "must be the index of a state");
  }
  if (raw.params !== undefined && (!Array.isArray(raw.params) || !raw.params.every((name) => typeof name === "string"))) {
    throw new ItfError("$.params", "must be an array of parameter names");
  }
  return {
    vars,
    states,
    meta,
    ...(raw.params !== undefined ? { params: raw.params as string[] } : {}),
    ...(raw.loop !== undefined ? { loop: raw.loop as number } : {}),
  };
}

/** The action Quint took to reach this state (`mbt::actionTaken`), when the trace has one. */
export function itfAction(state: ItfState): string | undefined {
  const action = state[ACTION_TAKEN];
  return typeof action === "string" ? action : undefined;
}

/**
 * The nondeterministic picks behind this state (`mbt::nondetPicks`), decoded. Quint writes
 * each pick as an Option variant: Some(x) becomes x and None becomes undefined.
 */
export function itfPicks(state: ItfState): Record<string, ItfValue | undefined> {
  const picks = state[NONDET_PICKS];
  if (picks === undefined) return {};
  const decoded = decodeItfValue(picks, `$.${NONDET_PICKS}`);
  if (!isRecord(decoded)) throw new ItfError(`$.${NONDET_PICKS}`, "must be a record of picks");
  const out: Record<string, ItfValue | undefined> = {};
  for (const [name, pick] of Object.entries(decoded)) {
    if (isRecord(pick) && pick.tag === "Some" && "value" in pick) out[name] = pick.value as ItfValue;
    else if (isRecord(pick) && pick.tag === "None") out[name] = undefined;
    else out[name] = pick as ItfValue;
  }
  return out;
}
