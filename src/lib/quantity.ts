export const MAX_INT32 = 2_147_483_647;
const CPU = /^([0-9]*\.?[0-9]+)(m)?$/;
const MEMORY =
  /^([0-9]*\.?[0-9]+)(Ki|Mi|Gi|Ti|Pi|Ei|K|M|G|T|P|E)?$/;

const BINARY: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};

const DECIMAL: Record<string, number> = {
  K: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  P: 1000 ** 5,
  E: 1000 ** 6,
};

export function parseCpu(raw: string | number): number {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) {
      throw new Error(`Invalid CPU quantity "${raw}".`);
    }
    return Math.round(raw * 1000);
  }
  const match = raw.trim().match(CPU);
  if (!match) throw new Error(`Invalid CPU quantity "${raw}".`);
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid CPU quantity "${raw}".`);
  }
  return match[2] === "m" ? Math.round(value) : Math.round(value * 1000);
}

export function parseMemory(raw: string | number): number {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) {
      throw new Error(`Invalid memory quantity "${raw}".`);
    }
    return Math.round(raw);
  }
  const match = raw.trim().match(MEMORY);
  if (!match) throw new Error(`Invalid memory quantity "${raw}".`);
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid memory quantity "${raw}".`);
  }
  const unit = match[2] ?? "";
  const factor = BINARY[unit] ?? DECIMAL[unit] ?? 1;
  return Math.round(value * factor);
}

export function formatCpu(milli: number): string {
  if (milli % 1000 === 0) return String(milli / 1000);
  return `${milli}m`;
}

export function formatMemory(bytes: number): string {
  const units: Array<[string, number]> = [
    ["Gi", 1024 ** 3],
    ["Mi", 1024 ** 2],
    ["Ki", 1024],
  ];
  for (const [name, size] of units) {
    if (bytes >= size && bytes % size === 0) return `${bytes / size}${name}`;
  }
  return String(bytes);
}

/**
 * Same acceptance rules as IntOrString plus apimachinery's percent check:
 * a bare number is absolute, a string must be digits and a trailing `%`.
 * Quoted numbers such as `"1"` are rejected, which is what the API server does.
 * The calculator turns a typed integer into a number before calling this.
 */
export function parseIntOrPercent(
  raw: unknown,
  field: string,
): { kind: "absolute" | "percent"; value: number } {
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0 || raw > MAX_INT32) {
      throw new Error(`${field} must be an integer from 0 to 2147483647, or a percent.`);
    }
    return { kind: "absolute", value: raw };
  }
  if (typeof raw === "string") {
    const text = raw.trim();
    if (/^[0-9]+%$/.test(text)) {
      const value = Number(text.slice(0, -1));
      if (!Number.isSafeInteger(value) || value > MAX_INT32) {
        throw new Error(`${field} must be an integer from 0 to 2147483647, or a percent.`);
      }
      return { kind: "percent", value };
    }
    throw new Error(
      `${field} must be a number or a percentage such as 25%. The API rejects quoted numbers.`,
    );
  }
  throw new Error(`${field} must be an integer from 0 to 2147483647, or a percent.`);
}

export function formatIntOrPercent(value: {
  kind: "absolute" | "percent";
  value: number;
}): string {
  return value.kind === "percent" ? `${value.value}%` : String(value.value);
}

/** Same rounding as intstr.GetScaledValueFromIntOrPercent. */
export function scaleIntOrPercent(
  value: { kind: "absolute" | "percent"; value: number },
  total: number,
  roundUp: boolean,
): number {
  if (value.kind === "absolute") return value.value;
  const product = value.value * total;
  if (roundUp) return Math.floor((product + 99) / 100);
  return Math.floor(product / 100);
}
