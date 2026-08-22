import { defineConfig } from "tsdown";

/**
 * Two builds, not one with two entries. A single build code-splits what the library
 * and the CLI share into a third chunk, which turns `dist/index.js` into a re-export
 * shim: the CLI's convenience would be paid for by every browser that imports the
 * library. Separate builds keep `dist/index.js` byte-identical to the one the bundle
 * baseline in `bench/baseline.json` was recorded against.
 */
export default defineConfig([
  {
    entry: "src/index.ts",
    format: "esm",
    platform: "neutral",
    target: "es2022",
    dts: true,
    sourcemap: true,
    treeshake: true,
    clean: true,
  },
  {
    // The CLI imports node:fs, node:path, node:url and node:util, so it cannot be
    // neutral. No `dts`: nothing imports it, `bin` points at the JS. `clean` is off so
    // it does not delete the library build that just ran. The named entry is what makes
    // the file `dist/cli.mjs` rather than `dist/cli-bin.mjs`.
    entry: { cli: "src/cli-bin.ts" },
    // Keeps the library out of the bin: `dist/cli.mjs` imports `./index.js` at runtime
    // instead of inlining a second copy of it, which is 5.8 kB on disk instead of 88.
    deps: { neverBundle: ["./index.js"] },
    format: "esm",
    platform: "node",
    target: "node20",
    dts: false,
    sourcemap: true,
    treeshake: true,
    clean: false,
  },
]);
