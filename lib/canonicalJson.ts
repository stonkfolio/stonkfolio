/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace,
 * bigints written as decimal strings, PublicKey-like values as base58, and
 * `undefined` object fields omitted. Serialized by hand rather than through
 * JSON.stringify(object) because JS enumerates integer-like keys ("9", "10")
 * before other keys regardless of insertion order.
 *
 * Every published round artifact goes through this, so the same inputs always
 * hash to the same bytes on any machine.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "bigint":
      return JSON.stringify(value.toString());
    case "number":
      if (!Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number ${value}`);
      return JSON.stringify(value);
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      if (value instanceof Uint8Array) throw new Error("canonicalJson: encode byte arrays as hex strings first");
      const maybeKey = value as { toBase58?: () => string };
      if (typeof maybeKey.toBase58 === "function") return JSON.stringify(maybeKey.toBase58());
      const record = value as Record<string, unknown>;
      const fields = Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
      return `{${fields.join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
  }
}
