/**
 * Small hand-written validation helpers shared by every per-type validator in parse.ts.
 * No schema library (e.g. ajv) is used on purpose -- the protocol is small and stable
 * enough that explicit checks are easier to audit than a generic validator.
 */

export type Fields = Record<string, unknown>;

export function isString(obj: Fields, key: string): boolean {
  return typeof obj[key] === "string";
}

export function isOptionalString(obj: Fields, key: string): boolean {
  return obj[key] === undefined || typeof obj[key] === "string";
}

export function isNumber(obj: Fields, key: string): boolean {
  return typeof obj[key] === "number" && Number.isFinite(obj[key] as number);
}

export function isOptionalNumber(obj: Fields, key: string): boolean {
  return obj[key] === undefined || isNumber(obj, key);
}

export function isVector3(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Fields;
  return isNumber(v, "x") && isNumber(v, "y") && isNumber(v, "z");
}

export function isQuaternion(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const q = value as Fields;
  return isNumber(q, "qx") && isNumber(q, "qy") && isNumber(q, "qz") && isNumber(q, "qw");
}

export function isStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

export function isBoolean(obj: Fields, key: string): boolean {
  return typeof obj[key] === "boolean";
}
