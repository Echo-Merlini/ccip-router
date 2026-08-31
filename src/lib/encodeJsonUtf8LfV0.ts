/**
 * encode-json-utf8-lf.v0 — conformant producer.
 *
 * Binds to the immutable recompute-kit contract:
 *   spec    conformance/encode-json-utf8-lf-v0/encode-json-utf8-lf-v0.spec.md
 *           sha256 22207f8c4047044414da98b5497a2c9683aea14a7a498fc1819a9094c920a1f9
 *   vectors conformance/encode-json-utf8-lf-v0/encode-json-utf8-lf-v0.vectors.json
 *           sha256 8d53ab1d3dfb2de1ba9db23ed06d6864b08b516451938a4b1f6db6bcdcf1950f  (48 vectors)
 *   repo    github.com/trustless-ai/recompute-kit @ f1d75a530761c983e8b6900f036935ac7758538c
 *
 * This replaces a naive `JSON.stringify(sorted)+"\n"` that MATCHED the .v0 bytes on string/int inputs but
 * did not enforce the .v0 domain — so pathological values (negative zero, non-finite, unsafe integers,
 * lone surrogates) were silently mangled instead of rejected, and could collide (Infinity and null both
 * -> {"v":null}; 2^53+1 and 2^53 both -> 9007199254740992). For an identity/dedup preimage that is an
 * injectivity failure. This encoder is byte-identical to the naive one on every CONFORMING input (so
 * existing dedup identities are unchanged) and fail-closed (throws DomainError) on every non-conforming one.
 *
 * Ported faithfully from the recompute-kit reference encoder.ts (Bun -> node/tsx-safe APIs) and qualified
 * by the 48 pinned vectors in this directory's test.
 */
import { createHash } from "node:crypto";

const SAFE_INTEGER = 9007199254740991;
const KNOWN_ERRORS = new Set([
  "INTEGER_OUT_OF_RANGE",
  "NEGATIVE_ZERO",
  "NON_FINITE_NUMBER",
  "NON_SCALAR_KEY",
  "NON_SCALAR_STRING",
  "NUMBER_NOT_EXACTLY_BINARY64",
]);

export class DomainError extends Error {
  category: string;
  constructor(category: string) {
    if (!KNOWN_ERRORS.has(category)) throw new Error(`unknown domain-error category: ${category}`);
    super(category);
    this.category = category;
    this.name = "DomainError";
  }
}

type F64Value = { kind: "f64"; bits: bigint; value: number };
type IntegerValue = { kind: "integer"; value: bigint };
type ObjectValue = { kind: "object"; entries: Array<[string, AbstractValue]> };
export type AbstractValue = null | boolean | string | F64Value | IntegerValue | ObjectValue | AbstractValue[];

function scalarError(value: string, key: boolean): string | null {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return key ? "NON_SCALAR_KEY" : "NON_SCALAR_STRING";
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return key ? "NON_SCALAR_KEY" : "NON_SCALAR_STRING";
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return key ? "NON_SCALAR_KEY" : "NON_SCALAR_STRING";
    }
  }
  return null;
}

function compareUtf16(left: string, right: string): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const a = left.charCodeAt(index);
    const b = right.charCodeAt(index);
    if (a !== b) return a < b ? -1 : 1;
  }
  return left.length - right.length;
}

function escapeString(value: string, key = false): string {
  const invalid = scalarError(value, key);
  if (invalid) throw new DomainError(invalid);
  let out = '"';
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      out += value[index] + value[index + 1];
      index += 1;
      continue;
    }
    if (unit === 0x22) out += '\\"';
    else if (unit === 0x5c) out += "\\\\";
    else if (unit === 0x08) out += "\\b";
    else if (unit === 0x0c) out += "\\f";
    else if (unit === 0x0a) out += "\\n";
    else if (unit === 0x0d) out += "\\r";
    else if (unit === 0x09) out += "\\t";
    else if (unit <= 0x1f) out += `\\u${unit.toString(16).padStart(4, "0")}`;
    else out += value[index];
  }
  return out + '"';
}

function renderNumber(value: F64Value | IntegerValue): string {
  let number: number;
  if (value.kind === "integer") {
    const bound = 9007199254740991n;
    if (value.value < -bound || value.value > bound) throw new DomainError("INTEGER_OUT_OF_RANGE");
    number = Number(value.value);
    if (BigInt(number) !== value.value) throw new DomainError("NUMBER_NOT_EXACTLY_BINARY64");
  } else {
    number = value.value;
    if (!Number.isFinite(number)) throw new DomainError("NON_FINITE_NUMBER");
    if (Object.is(number, -0)) throw new DomainError("NEGATIVE_ZERO");
    if (Number.isInteger(number) && Math.abs(number) > SAFE_INTEGER) {
      throw new DomainError("INTEGER_OUT_OF_RANGE");
    }
  }
  // Isolated ECMAScript / RFC 8785 §3.2.2.3 number-rendering step, only after the v0 domain accepted it.
  return JSON.stringify(number) as string;
}

function serialize(value: AbstractValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return escapeString(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  if (value.kind === "f64" || value.kind === "integer") return renderNumber(value);
  const seen = new Set<string>();
  for (const [key] of value.entries) {
    const invalid = scalarError(key, true);
    if (invalid) throw new DomainError(invalid);
    if (seen.has(key)) throw new Error("object contains duplicate key");
    seen.add(key);
  }
  const entries = [...value.entries].sort((a, b) => compareUtf16(a[0], b[0]));
  return `{${entries.map(([key, item]) => `${escapeString(key, true)}:${serialize(item)}`).join(",")}}`;
}

/** UTF-8 bytes: serialize(value) + exactly one trailing LF. */
export function encode(value: AbstractValue): Uint8Array {
  return new TextEncoder().encode(`${serialize(value)}\n`);
}

/** Map a plain JS value into the abstract domain, enforcing v0. Every JS number is binary64; route it
 *  through the f64 branch so -0 / non-finite / unsafe-integer are REJECTED, never silently coerced. */
function fromPlain(value: unknown): AbstractValue {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return { kind: "integer", value };
  if (typeof value === "number") {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, value, false);
    return { kind: "f64", bits: new DataView(buffer).getBigUint64(0, false), value };
  }
  if (Array.isArray(value)) return value.map(fromPlain);
  if (typeof value === "object") {
    const entries: Array<[string, AbstractValue]> = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue; // JSON.stringify drops undefined; match that, don't emit "null"
      entries.push([k, fromPlain(v)]);
    }
    return { kind: "object", entries };
  }
  throw new DomainError("NON_SCALAR_STRING"); // function/symbol/undefined at top level: not a JSON value
}

/** The public producer: v0-canonical string (sorted-key UTF-8 JSON + one trailing LF) for a plain JS
 *  object. Throws DomainError on any value outside the encode-json-utf8-lf.v0 domain. */
export function encodeJsonUtf8LfV0(obj: unknown): string {
  return `${serialize(fromPlain(obj))}\n`;
}

// ---- conformance harness (used only by the vector test; mirrors the reference adapter) ----

type Transport = {
  type: string;
  value?: unknown;
  decimal?: string;
  hex?: string;
  items?: Transport[];
  entries?: Array<{ key: string; value: Transport }>;
};
type AdapterResult =
  | { status: "success"; bytes_hex: string; byte_length: number; sha256: string }
  | { status: "rejection"; error: string };

export function decodeTransport(node: Transport): AbstractValue {
  if (node.type === "null") return null;
  if (node.type === "boolean") return Boolean(node.value);
  if (node.type === "string") return String(node.value);
  if (node.type === "integer") {
    if (typeof node.decimal !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(node.decimal)) {
      throw new Error("invalid integer carrier");
    }
    return { kind: "integer", value: BigInt(node.decimal) };
  }
  if (node.type === "f64_bits") {
    if (typeof node.hex !== "string" || !/^[0-9a-f]{16}$/.test(node.hex)) {
      throw new Error("invalid f64_bits carrier");
    }
    const bits = BigInt(`0x${node.hex}`);
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setBigUint64(0, bits, false);
    return { kind: "f64", bits, value: view.getFloat64(0, false) };
  }
  if (node.type === "array") return (node.items ?? []).map(decodeTransport);
  if (node.type === "object") {
    return {
      kind: "object",
      entries: (node.entries ?? []).map((e) => [e.key, decodeTransport(e.value)] as [string, AbstractValue]),
    };
  }
  throw new Error(`unknown fixture transport type: ${node.type}`);
}

export function gradeVector(input: Transport): AdapterResult {
  try {
    const bytes = encode(decodeTransport(input));
    return {
      status: "success",
      bytes_hex: Buffer.from(bytes).toString("hex"),
      byte_length: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { status: "rejection", error: error.category };
  }
}
