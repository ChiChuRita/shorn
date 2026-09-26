import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "src/index.ts",
  format: "esm",
  platform: "neutral",
  target: "es2022",
  // Members tagged `@internal` leave the published types: the machinery `compile()`,
  // `fingerprinted()` and the async entry points share, which no caller reads or
  // overrides. The runtime keeps every one of them.
  dts: { compilerOptions: { stripInternal: true } },
  sourcemap: true,
  treeshake: true,
  clean: true,
});
