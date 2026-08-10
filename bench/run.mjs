import { createRequire } from "node:module";
import os from "node:os";
import process from "node:process";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  gunzipSync,
  gzipSync,
} from "node:zlib";
import { encode as messagePackEncode, decode as messagePackDecode } from "@msgpack/msgpack";
import avro from "avsc";
import { Encoder as CborEncoder } from "cbor-x";
import { Packr, isNativeAccelerationEnabled } from "msgpackr";
import protobuf from "protobufjs";
import { z } from "zod";
import { compile, m } from "../dist/index.js";
import * as fixtures from "./fixtures.mjs";
import { median } from "./measure.mjs";

const require = createRequire(import.meta.url);
const schemapack = require("schemapack");

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const args = new Set(process.argv.slice(2));
const quick = args.has("--quick");
const large = args.has("--large");
const highEntropy = args.has("--high-entropy");
const batchSize = large ? 100_000 : 100;
const targetSampleMs = quick ? 60 : 180;
const sampleCount = quick ? 3 : 7;
let sink = 0;

const person = Object.freeze({ name: "Rahul", age: 25, sex: "M" });
const unicodePerson = Object.freeze({ name: "Grüße 👋 राहुल", age: 25, sex: "M" });
const event = Object.freeze({
  id: 731_942,
  timestamp: 1_725_435_678,
  active: true,
  actor: person,
  metrics: Object.freeze({ cpu: 0.625, memory: 786_432 }),
  tags: Object.freeze(["api", "edge", "paid"]),
});
function token(index, salt) {
  let value = Math.imul(index + salt, 0x9e3779b1) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  return value.toString(36).padStart(7, "0");
}

/**
 * A monotonic counter with a realistic gap between readings.
 *
 * `id`, `timestamp` and `memory` used to step by exactly 1, 1 and 1,024, and that
 * is not a neutral choice: a perfectly constant stride is close to the best case a
 * fixed-width big-endian integer can be handed, because the high bytes then stay
 * identical across thousands of consecutive records and LZ77 matches those runs
 * for free. shorn's LEB128 varints are 40% smaller raw and get no such gift, so
 * the fixture was quietly deciding a compressed-size comparison that the formats
 * should have decided. Measured: under Brotli the constant-stride fixture puts
 * msgpackr's shared records ahead, and a jittered one puts shorn ahead, with no
 * change to any codec — so the jitter is the honest fixture, not a thumb on the
 * scale. Measured 2026-08-09.
 *
 * `Math.abs` because `token`'s final XOR yields a signed int, so its base36 form
 * can lead with "-"; without it the gaps go negative and the counter becomes a
 * random walk rather than a counter.
 */
const gap = (index, salt, spread) =>
  Math.abs(Number.parseInt(token(index, salt).slice(0, 5), 36)) % spread;

let idCursor = event.id;
let clock = event.timestamp;
let bytesUsed = 500_000;

const batch = Object.freeze(
  Array.from({ length: batchSize }, (_, index) => ({
    id: (idCursor += 1 + gap(index, 3, 40)),
    timestamp: (clock += 1 + gap(index, 5, 900)),
    active: index % 7 !== 0,
    actor: {
      name: highEntropy
        ? `user-${index}-${token(index, 17)}`
        : index % 3 === 0
          ? "Rahul"
          : index % 3 === 1
            ? "Ada"
            : "Linus",
      age: 20 + (index % 50),
      sex: index % 3 === 0 ? "M" : index % 3 === 1 ? "F" : "X",
    },
    metrics: { cpu: (index % 16) / 16, memory: (bytesUsed += 1_024 + gap(index, 7, 4_096)) },
    tags: highEntropy
      ? [`trace-${token(index, 31)}`, `span-${token(index, 47)}`]
      : index % 2 === 0
        ? ["api", "edge", "paid"]
        : ["worker", "free"],
  })),
);

const { person: Person, event: Event, batch: Batch } = fixtures;

const personJsonSchema = z.object({
  age: z.int().nonnegative(),
  name: z.string(),
  sex: z.enum(["F", "M", "X"]),
});
const validatedPerson = compile(personJsonSchema);

const avroPersonSchema = {
  type: "record",
  name: "Person",
  fields: [
    { name: "age", type: "int" },
    { name: "name", type: "string" },
    { name: "sex", type: { type: "enum", name: "Sex", symbols: ["F", "M", "X"] } },
  ],
};
const avroMetricsSchema = {
  type: "record",
  name: "Metrics",
  fields: [
    { name: "cpu", type: "double" },
    { name: "memory", type: "int" },
  ],
};
const avroEventSchema = {
  type: "record",
  name: "Event",
  fields: [
    { name: "active", type: "boolean" },
    { name: "actor", type: "Person" },
    { name: "id", type: "int" },
    { name: "metrics", type: "Metrics" },
    { name: "tags", type: { type: "array", items: "string" } },
    { name: "timestamp", type: "int" },
  ],
};
const avroPerson = avro.Type.forSchema(avroPersonSchema);
const avroEvent = avro.Type.forSchema(avroEventSchema, {
  registry: { Person: avroPerson, Metrics: avro.Type.forSchema(avroMetricsSchema) },
});
const avroBatch = avro.Type.forSchema({ type: "array", items: avroEvent });

const protoRoot = new protobuf.Root();
const ProtoSex = new protobuf.Enum("Sex", { F: 0, M: 1, X: 2 });
const ProtoPerson = new protobuf.Type("Person")
  .add(new protobuf.Field("age", 1, "uint32"))
  .add(new protobuf.Field("name", 2, "string"))
  .add(new protobuf.Field("sex", 3, "Sex"));
const ProtoMetrics = new protobuf.Type("Metrics")
  .add(new protobuf.Field("cpu", 1, "double"))
  .add(new protobuf.Field("memory", 2, "uint32"));
const ProtoEvent = new protobuf.Type("Event")
  .add(new protobuf.Field("active", 1, "bool"))
  .add(new protobuf.Field("actor", 2, "Person"))
  .add(new protobuf.Field("id", 3, "uint32"))
  .add(new protobuf.Field("metrics", 4, "Metrics"))
  .add(new protobuf.Field("tags", 5, "string", "repeated"))
  .add(new protobuf.Field("timestamp", 6, "uint32"));
const ProtoBatch = new protobuf.Type("Batch").add(
  new protobuf.Field("events", 1, "Event", "repeated"),
);
protoRoot.add(ProtoSex).add(ProtoPerson).add(ProtoMetrics).add(ProtoEvent).add(ProtoBatch);
protoRoot.resolveAll();

function protoCodec(type, wrap = false) {
  return {
    encode(value) {
      const input = wrap ? { events: value } : value;
      return type.encode(type.fromObject(input)).finish();
    },
    decode(bytes) {
      const value = type.toObject(type.decode(bytes), {
        arrays: true,
        enums: String,
        objects: true,
      });
      return wrap ? value.events : value;
    },
  };
}

const schemaPackPerson = schemapack.build(
  { age: "varuint", name: "string", sex: "string" },
  false,
);
const schemaPackEventShape = {
  active: "boolean",
  actor: { age: "varuint", name: "string", sex: "string" },
  id: "varuint",
  metrics: { cpu: "float64", memory: "varuint" },
  tags: ["string"],
  timestamp: "varuint",
};
const schemaPackEvent = schemapack.build(schemaPackEventShape, false);
const schemaPackBatch = schemapack.build([schemaPackEventShape], false);

function createGenericCodecs() {
  const msgpack = new Packr({ useRecords: false });
  const msgpackRecords = new Packr({ useRecords: true, structures: [] });
  const cbor = new CborEncoder({ useRecords: false });
  const cborRecords = new CborEncoder({ useRecords: true, structures: [] });
  return { msgpack, msgpackRecords, cbor, cborRecords };
}

function makeImplementations(value, schema, avroType, protoType, schemaPackType, wrapProto = false) {
  const { msgpack, msgpackRecords, cbor, cborRecords } = createGenericCodecs();
  const proto = protoCodec(protoType, wrapProto);

  // Establish the out-of-band record tables before measuring steady-state payloads.
  msgpackRecords.pack(value);
  cborRecords.encode(value);

  return [
    {
      name: "this library (schema)",
      encode: (input) => schema.encode(input),
      decode: (bytes) => schema.decode(bytes),
    },
    {
      name: "Avro / avsc (schema)",
      encode: (input) => avroType.toBuffer(input),
      decode: (bytes) => avroType.fromBuffer(bytes),
    },
    {
      name: "Protobuf.js reflection*",
      encode: (input) => proto.encode(input),
      decode: (bytes) => proto.decode(bytes),
    },
    {
      name: "SchemaPack (schema)",
      encode: (input) => schemaPackType.encode(input),
      decode: (bytes) => schemaPackType.decode(bytes),
    },
    {
      name: "msgpackr MessagePack",
      encode: (input) => msgpack.pack(input),
      decode: (bytes) => msgpack.unpack(bytes),
    },
    {
      name: "msgpackr shared records†",
      encode: (input) => msgpackRecords.pack(input),
      decode: (bytes) => msgpackRecords.unpack(bytes),
    },
    {
      name: "@msgpack/msgpack",
      encode: (input) => messagePackEncode(input),
      decode: (bytes) => messagePackDecode(bytes),
    },
    {
      name: "cbor-x CBOR",
      encode: (input) => cbor.encode(input),
      decode: (bytes) => cbor.decode(bytes),
    },
    {
      name: "cbor-x shared records†",
      encode: (input) => cborRecords.encode(input),
      decode: (bytes) => cborRecords.decode(bytes),
    },
    {
      name: "JSON string‡",
      encode: (input) => JSON.stringify(input),
      decode: (text) => JSON.parse(text),
      size: (text) => Buffer.byteLength(text),
    },
    {
      name: "JSON bytes",
      encode: (input) => textEncoder.encode(JSON.stringify(input)),
      decode: (bytes) => JSON.parse(textDecoder.decode(bytes)),
    },
  ];
}

// The three samplers below stay bespoke: each returns a different unit (ops/s,
// ops/s over one large call, ms of latency) and their calibration is what every
// published performance table was measured with.
function measure(operation) {
  for (let index = 0; index < 2_000; index++) sink ^= operation();

  let iterations = 200;
  while (true) {
    const start = performance.now();
    for (let index = 0; index < iterations; index++) sink ^= operation();
    const elapsed = performance.now() - start;
    if (elapsed >= targetSampleMs / 3 || iterations >= 2_000_000) {
      iterations = Math.max(1, Math.min(2_000_000, Math.round(iterations * (targetSampleMs / elapsed))));
      break;
    }
    iterations *= 4;
  }

  const samples = [];
  for (let sample = 0; sample < sampleCount; sample++) {
    const start = performance.now();
    for (let index = 0; index < iterations; index++) sink ^= operation();
    samples.push((iterations * 1_000) / (performance.now() - start));
  }
  return Math.round(median(samples));
}

function measureLarge(operation) {
  operation();
  operation();
  const samples = [];
  for (let sample = 0; sample < sampleCount; sample++) {
    const start = performance.now();
    sink ^= operation();
    samples.push(1_000 / (performance.now() - start));
  }
  return Math.round(median(samples));
}

function bytesOf(encoded, implementation) {
  return implementation.size ? implementation.size(encoded) : encoded.byteLength;
}

function measureLatency(operation) {
  operation();
  const samples = [];
  for (let sample = 0; sample < sampleCount; sample++) {
    const start = performance.now();
    operation();
    samples.push(performance.now() - start);
  }
  return median(samples);
}

function compressionStats(encoded) {
  const gzip = gzipSync(encoded);
  const brotli = brotliCompressSync(encoded, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 6 },
  });
  return {
    gzip: gzip.byteLength,
    brotli: brotli.byteLength,
    gzipMs: measureLatency(() => gzipSync(encoded)),
    gunzipMs: measureLatency(() => gunzipSync(gzip)),
    brotliMs: measureLatency(() =>
      brotliCompressSync(encoded, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 6 },
      }),
    ),
    unbrotliMs: measureLatency(() => brotliDecompressSync(brotli)),
  };
}

function decodeSignal(decoded, kind) {
  if (kind === "person") return decoded.age;
  if (kind === "event") return decoded.id;
  return decoded.length;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function benchmarkFixture(label, kind, value, implementations) {
  const rows = implementations.map((implementation) => {
    const encoded = implementation.encode(value);
    const decoded = implementation.decode(encoded);
    if (JSON.stringify(canonical(decoded)) !== JSON.stringify(canonical(value))) {
      throw new Error(`${implementation.name} failed the ${label} round trip`);
    }
    const compressed = large && kind === "batch" ? compressionStats(encoded) : undefined;
    const measureThroughput = large && kind === "batch" ? measureLarge : measure;
    return {
      name: implementation.name,
      bytes: bytesOf(encoded, implementation),
      gzip: compressed?.gzip,
      brotli: compressed?.brotli,
      gzipMs: compressed?.gzipMs,
      gunzipMs: compressed?.gunzipMs,
      brotliMs: compressed?.brotliMs,
      unbrotliMs: compressed?.unbrotliMs,
      encodeOps: measureThroughput(() => bytesOf(implementation.encode(value), implementation)),
      decodeOps: measureThroughput(() => decodeSignal(implementation.decode(encoded), kind)),
    };
  });

  const smallest = Math.min(...rows.map((row) => row.bytes));
  const fastestEncode = Math.max(...rows.map((row) => row.encodeOps));
  const fastestDecode = Math.max(...rows.map((row) => row.decodeOps));
  console.log(`\n${label}`);
  console.table(
    rows.map((row) => ({
      codec: row.name,
      bytes: row.bytes,
      "size vs best": `${(row.bytes / smallest).toFixed(2)}x`,
      ...(row.gzip === undefined ? {} : { gzip: row.gzip, "brotli q6": row.brotli }),
      "encode ops/s": row.encodeOps.toLocaleString("en-US"),
      "encode vs best": `${(row.encodeOps / fastestEncode).toFixed(2)}x`,
      "decode ops/s": row.decodeOps.toLocaleString("en-US"),
      "decode vs best": `${(row.decodeOps / fastestDecode).toFixed(2)}x`,
    })),
  );
  if (large && kind === "batch") {
    console.log("Compression CPU cost in milliseconds; Brotli uses quality 6.");
    console.table(
      rows.map((row) => ({
        codec: row.name,
        gzip: row.gzipMs.toFixed(2),
        gunzip: row.gunzipMs.toFixed(2),
        "brotli q6": row.brotliMs.toFixed(2),
        unbrotli: row.unbrotliMs.toFixed(2),
      })),
    );
  }
  return rows;
}

function benchmarkValidatedPerson() {
  const { msgpack, msgpackRecords, cbor } = createGenericCodecs();
  msgpackRecords.pack(person);
  const proto = protoCodec(ProtoPerson);
  const candidates = [
    {
      name: "this library + Zod",
      encode: (value) => validatedPerson.encode(value),
      decode: (bytes) => validatedPerson.decode(bytes),
    },
    {
      name: "Zod + Avro / avsc",
      encode: (value) => avroPerson.toBuffer(personJsonSchema.parse(value)),
      decode: (bytes) => personJsonSchema.parse(avroPerson.fromBuffer(bytes)),
    },
    {
      name: "Zod + Protobuf.js*",
      encode: (value) => proto.encode(personJsonSchema.parse(value)),
      decode: (bytes) => personJsonSchema.parse(proto.decode(bytes)),
    },
    {
      name: "Zod + SchemaPack",
      encode: (value) => schemaPackPerson.encode(personJsonSchema.parse(value)),
      decode: (bytes) => personJsonSchema.parse(schemaPackPerson.decode(bytes)),
    },
    {
      name: "Zod + msgpackr",
      encode: (value) => msgpack.pack(personJsonSchema.parse(value)),
      decode: (bytes) => personJsonSchema.parse(msgpack.unpack(bytes)),
    },
    {
      name: "Zod + msgpackr records†",
      encode: (value) => msgpackRecords.pack(personJsonSchema.parse(value)),
      decode: (bytes) => personJsonSchema.parse(msgpackRecords.unpack(bytes)),
    },
    {
      name: "Zod + cbor-x",
      encode: (value) => cbor.encode(personJsonSchema.parse(value)),
      decode: (bytes) => personJsonSchema.parse(cbor.decode(bytes)),
    },
    {
      name: "Zod + JSON string‡",
      encode: (value) => JSON.stringify(personJsonSchema.parse(value)),
      decode: (text) => personJsonSchema.parse(JSON.parse(text)),
      size: (text) => Buffer.byteLength(text),
    },
    {
      name: "Zod + JSON bytes",
      encode: (value) => textEncoder.encode(JSON.stringify(personJsonSchema.parse(value))),
      decode: (bytes) => personJsonSchema.parse(JSON.parse(textDecoder.decode(bytes))),
    },
  ];
  return benchmarkFixture("Person — validated end-to-end", "person", person, candidates);
}

console.log("Schema-guided serialization benchmark");
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      cpu: os.cpus()[0]?.model,
      msgpackrNativeAcceleration: isNativeAccelerationEnabled,
      targetSampleMs,
      samples: sampleCount,
      dataProfile: highEntropy ? "high-entropy unique strings" : "repetitive application data",
    },
    null,
    2,
  ),
);
console.log("Higher ops/s is better. Payload bytes exclude the schema/shared structure itself.");

const results = {
  person: benchmarkFixture(
    "Person — raw codec",
    "person",
    person,
    makeImplementations(person, Person, avroPerson, ProtoPerson, schemaPackPerson),
  ),
  unicodePerson: benchmarkFixture(
    "Unicode person — raw codec",
    "person",
    unicodePerson,
    makeImplementations(unicodePerson, Person, avroPerson, ProtoPerson, schemaPackPerson),
  ),
  event: benchmarkFixture(
    "Nested event — raw codec",
    "event",
    event,
    makeImplementations(event, Event, avroEvent, ProtoEvent, schemaPackEvent),
  ),
  batch: benchmarkFixture(
    `${batchSize.toLocaleString("en-US")}-event batch (${highEntropy ? "high entropy" : "repetitive"}) — raw codec`,
    "batch",
    batch,
    makeImplementations(batch, Batch, avroBatch, ProtoBatch, schemaPackBatch, true),
  ),
  validatedPerson: benchmarkValidatedPerson(),
};

if (process.env.BENCH_JSON === "1") {
  console.log(`BENCHMARK_JSON=${JSON.stringify(results)}`);
}
console.log("\n* Protobuf.js includes fromObject/toObject conversion for the same string-enum JS API.");
console.log("† Shared-record payloads require a synchronized structure table outside the measured bytes.");
console.log(
  "‡ JSON string stops at a JS string while every other codec produces bytes; its size column is still the UTF-8 byte length, so its speed and size are measured on different artifacts. JSON bytes is the like-for-like row.",
);
console.log(`Benchmark sink: ${sink}`);
