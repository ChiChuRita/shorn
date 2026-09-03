import { gzipSync } from "node:zlib";
import { build } from "esbuild";

async function measure(contents) {
  const result = await build({
    stdin: { contents, resolveDir: import.meta.dirname, loader: "js" },
    bundle: true,
    minify: true,
    treeShaking: true,
    write: false,
    platform: "browser",
    format: "esm",
    logLevel: "silent",
  });
  const bytes = result.outputFiles[0].contents;
  return { minified: bytes.length, gzip: gzipSync(bytes).length };
}

/**
 * Two shorn rows, because one row cannot answer the question honestly. Every other
 * codec here is schemaless and validates nothing, so `m` — the wire codec alone —
 * is the comparable surface. `compile` is that plus the Standard Schema adapter, which
 * buys validation none of the other rows perform; it belongs in the table, but as a
 * different row rather than as shorn's price for doing the same work.
 */
const entries = [
  ["shorn (m)", 'import { m } from "../dist/index.js"; globalThis.codec = m;'],
  [
    "shorn (compile, validating)",
    'import { compile } from "../dist/index.js"; globalThis.codec = compile;',
  ],
  ["msgpackr", 'import { pack, unpack } from "msgpackr"; globalThis.codec = [pack, unpack];'],
  [
    "@msgpack/msgpack",
    'import { encode, decode } from "@msgpack/msgpack"; globalThis.codec = [encode, decode];',
  ],
  ["cbor-x", 'import { encode, decode } from "cbor-x"; globalThis.codec = [encode, decode];'],
  ["avsc", 'import avro from "avsc"; globalThis.codec = avro.Type;'],
  ["protobufjs/light", 'import protobuf from "protobufjs/light.js"; globalThis.codec = protobuf;'],
  ["schemapack", 'import schemapack from "schemapack"; globalThis.codec = schemapack;'],
];

const rows = [];
for (const [name, contents] of entries) {
  try {
    rows.push({ codec: name, ...(await measure(contents)) });
  } catch (error) {
    rows.push({
      codec: name,
      minified: "n/a",
      gzip: "n/a",
      note: error.errors?.[0]?.text ?? error.message,
    });
  }
}

console.log("Minified browser bundle cost for imported codec API (schema declarations excluded)");
console.table(rows);

/**
 * The per-feature table the docs publish. Every row is a real import set, so a
 * feature that stops tree-shaking shows up here as a jump in the row below it
 * rather than as a claim nobody re-ran.
 */
const importSets = [
  ["compile", "compile"],
  ["compile + m", "compile, m"],
  ["+ safe", "compile, m, safeEncode, safeDecode"],
  ["+ async", "compile, m, safeEncode, safeDecode, encodeAsync, decodeAsync"],
  [
    "+ fingerprinted",
    "compile, m, safeEncode, safeDecode, encodeAsync, decodeAsync, fingerprinted",
  ],
  [
    "+ encodeInto",
    "compile, m, safeEncode, safeDecode, encodeAsync, decodeAsync, fingerprinted, encodeInto",
  ],
  ["everything", null],
];

const featureRows = [];
for (const [label, names] of importSets) {
  const contents =
    names === null
      ? 'import * as shorn from "../dist/index.js"; globalThis.codec = shorn;'
      : `import { ${names} } from "../dist/index.js"; globalThis.codec = [${names}];`;
  featureRows.push({ "import set": label, ...(await measure(contents)) });
}

console.log("\nWhat each feature costs the bundle that imports it");
console.table(featureRows);
