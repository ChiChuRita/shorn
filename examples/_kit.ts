// Shared reporting for the examples. Every number printed comes from a real encode
// in that example — nothing here estimates.
import { gzipSync } from "node:zlib";

export const jsonSize = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
export const gzipSize = (input: Uint8Array | string): number => gzipSync(input).length;

export function title(name: string): void {
  console.log(`\n\x1b[1m── ${name} ${"─".repeat(Math.max(2, 58 - name.length))}\x1b[0m`);
}

const fmt = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2);

export function row(label: string, shorn: number, json: number, unit = "B"): void {
  const ratio = json / shorn;
  const verdict = ratio >= 1 ? `${ratio.toFixed(2)}× smaller` : `\x1b[31m${(1 / ratio).toFixed(2)}× LARGER\x1b[0m`;
  console.log(
    `  ${label.padEnd(24)} shorn ${fmt(shorn).padStart(9)} ${unit.padEnd(7)} json ${fmt(json).padStart(9)} ${unit.padEnd(7)} ${verdict}`,
  );
}

export const note = (text: string): void => console.log(`  \x1b[2m· ${text}\x1b[0m`);
export const win = (text: string): void => console.log(`  \x1b[32m✔ ${text}\x1b[0m`);
export const pain = (text: string): void => console.log(`  \x1b[33m✖ ${text}\x1b[0m`);

/** Whatever a thrown value says, without the caller writing the instanceof dance. */
export function threw(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
