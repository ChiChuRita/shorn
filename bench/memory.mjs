import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import avro from "avsc";
import { Packr } from "msgpackr";
import * as fixtures from "./fixtures.mjs";

const require = createRequire(import.meta.url);
const schemapack = require("schemapack");
const workerIndex = process.argv.indexOf("--worker");

function values(count) {
  return Array.from({ length: count }, (_, index) => ({
    active: index % 7 !== 0,
    actor: {
      age: 20 + (index % 50),
      name: index % 3 === 0 ? "Rahul" : index % 3 === 1 ? "Ada" : "Linus",
      sex: index % 3 === 0 ? "M" : index % 3 === 1 ? "F" : "X",
    },
    id: 731_942 + index,
    metrics: { cpu: (index % 16) / 16, memory: 500_000 + index * 1_024 },
    tags: index % 2 === 0 ? ["api", "edge", "paid"] : ["worker", "free"],
    timestamp: 1_725_435_678 + index,
  }));
}

function shornCodec() {
  return {
    encode: (value) => fixtures.batch.encode(value),
    decode: (bytes) => fixtures.batch.decode(bytes),
  };
}

function avroCodec() {
  const person = avro.Type.forSchema({
    type: "record",
    name: "MemoryPerson",
    fields: [
      { name: "age", type: "int" },
      { name: "name", type: "string" },
      { name: "sex", type: { type: "enum", name: "MemorySex", symbols: ["F", "M", "X"] } },
    ],
  });
  const metrics = avro.Type.forSchema({
    type: "record",
    name: "MemoryMetrics",
    fields: [
      { name: "cpu", type: "double" },
      { name: "memory", type: "int" },
    ],
  });
  const event = avro.Type.forSchema(
    {
      type: "record",
      name: "MemoryEvent",
      fields: [
        { name: "active", type: "boolean" },
        { name: "actor", type: "MemoryPerson" },
        { name: "id", type: "int" },
        { name: "metrics", type: "MemoryMetrics" },
        { name: "tags", type: { type: "array", items: "string" } },
        { name: "timestamp", type: "int" },
      ],
    },
    { registry: { MemoryPerson: person, MemoryMetrics: metrics } },
  );
  const batch = avro.Type.forSchema({ type: "array", items: event });
  return { encode: (value) => batch.toBuffer(value), decode: (bytes) => batch.fromBuffer(bytes) };
}

function schemaPackCodec() {
  const event = {
    active: "boolean",
    actor: { age: "varuint", name: "string", sex: "string" },
    id: "varuint",
    metrics: { cpu: "float64", memory: "varuint" },
    tags: ["string"],
    timestamp: "varuint",
  };
  const batch = schemapack.build([event], false);
  return { encode: (value) => batch.encode(value), decode: (bytes) => batch.decode(bytes) };
}

function codecFor(name) {
  if (name === "this-library") return shornCodec();
  if (name === "avro") return avroCodec();
  if (name === "schemapack") return schemaPackCodec();
  if (name === "msgpackr-records") {
    const packr = new Packr({ useRecords: true, structures: [] });
    return { encode: (input) => packr.pack(input), decode: (bytes) => packr.unpack(bytes) };
  }
  if (name === "json") {
    return { encode: (input) => JSON.stringify(input), decode: (text) => JSON.parse(text) };
  }
  throw new Error(`Unknown codec ${name}`);
}

function retained(memory) {
  return memory.heapUsed + memory.external;
}

function collectGarbage() {
  global.gc();
  global.gc();
  global.gc();
}

if (workerIndex !== -1) {
  if (typeof global.gc !== "function") throw new Error("Memory worker requires --expose-gc");
  const name = process.argv[workerIndex + 1];
  const value = values(100_000);
  const codec = codecFor(name);
  const warmValue = value.slice(0, 100);
  const warmEncoded = codec.encode(warmValue);
  codec.decode(warmEncoded);
  collectGarbage();
  const before = process.memoryUsage();
  const encoded = codec.encode(value);
  collectGarbage();
  const afterEncode = process.memoryUsage();
  const decoded = codec.decode(encoded);
  collectGarbage();
  const afterDecode = process.memoryUsage();
  if (decoded.length !== value.length) throw new Error(`${name} failed round trip`);
  process.stdout.write(
    JSON.stringify({
      encodedBytes: typeof encoded === "string" ? Buffer.byteLength(encoded) : encoded.byteLength,
      encodeRetained: retained(afterEncode) - retained(before),
      decodeAdditional: retained(afterDecode) - retained(afterEncode),
      rssDelta: afterDecode.rss - before.rss,
    }),
  );
  process.exit(0);
}

const labels = {
  "this-library": "this library",
  avro: "Avro / avsc",
  schemapack: "SchemaPack",
  "msgpackr-records": "msgpackr shared records",
  json: "JSON",
};
const mib = (bytes) => +(bytes / 1_048_576).toFixed(2);
const rows = [];
for (const [name, label] of Object.entries(labels)) {
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", fileURLToPath(import.meta.url), "--worker", name],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`${label}: ${result.stderr || result.stdout}`);
  const measurement = JSON.parse(result.stdout);
  rows.push({
    codec: label,
    "payload MiB": mib(measurement.encodedBytes),
    "encode retained MiB": mib(measurement.encodeRetained),
    "decoded value MiB": mib(measurement.decodeAdditional),
    "RSS increase MiB": mib(measurement.rssDelta),
  });
}

console.log("Steady-state retained memory after forced GC for a 100,000-event value; isolated process per codec.");
console.log("This measures retained output/value memory, not transient peak allocation.");
console.table(rows);
