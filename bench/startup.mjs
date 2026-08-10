import { createRequire } from "node:module";
import avro from "avsc";
import { Packr } from "msgpackr";
import protobuf from "protobufjs";
import { z } from "zod";
import { compile, encode } from "../dist/index.js";
import { median } from "./measure.mjs";

const require = createRequire(import.meta.url);
const schemapack = require("schemapack");
const person = { age: 25, name: "Rahul", sex: "M" };
let unique = 0;
let sink = 0;

// Fixed iterations, not `nanosPerOp`: this measures cold setup, so the 20-iteration
// warmup and the caller's count are the measurement, not a detail to calibrate away.
function microsPerOperation(operation, iterations = 1_000, samples = 7) {
  for (let index = 0; index < 20; index++) sink ^= operation();
  const measurements = [];
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    for (let index = 0; index < iterations; index++) sink ^= operation();
    measurements.push(((performance.now() - start) * 1_000) / iterations);
  }
  return median(measurements);
}

function zodPerson() {
  return z.object({
    age: z.int().nonnegative(),
    name: z.string(),
    sex: z.enum(["F", "M", "X"]),
  });
}

function coldShorn() {
  const schema = zodPerson();
  return compile(schema).encode(person).byteLength;
}

function coldAvro() {
  const suffix = unique++;
  const type = avro.Type.forSchema({
    type: "record",
    name: `ColdPerson${suffix}`,
    fields: [
      { name: "age", type: "int" },
      { name: "name", type: "string" },
      {
        name: "sex",
        type: { type: "enum", name: `ColdSex${suffix}`, symbols: ["F", "M", "X"] },
      },
    ],
  });
  return type.toBuffer(person).byteLength;
}

function coldProtobuf() {
  const suffix = unique++;
  const root = new protobuf.Root();
  const sex = new protobuf.Enum(`ColdSex${suffix}`, { F: 0, M: 1, X: 2 });
  const type = new protobuf.Type(`ColdPerson${suffix}`)
    .add(new protobuf.Field("age", 1, "uint32"))
    .add(new protobuf.Field("name", 2, "string"))
    .add(new protobuf.Field("sex", 3, `ColdSex${suffix}`));
  root.add(sex).add(type).resolveAll();
  return type.encode(type.fromObject(person)).finish().byteLength;
}

function coldSchemaPack() {
  return schemapack
    .build({ age: "varuint", name: "string", sex: "string" }, false)
    .encode(person).byteLength;
}

function coldMsgpackrRecords() {
  return new Packr({ useRecords: true }).pack(person).byteLength;
}

const schema = zodPerson();
const compiled = compile(schema);
compiled.encode(person);

const rows = [
  ["this library + Zod", coldShorn, 1_000],
  ["Avro / avsc", coldAvro, 1_000],
  ["Protobuf.js reflection", coldProtobuf, 1_000],
  ["SchemaPack", coldSchemaPack, 1_000],
  ["msgpackr records", coldMsgpackrRecords, 1_000],
  ["JSON", () => JSON.stringify(person).length, 10_000],
].map(([codec, operation, iterations]) => ({
  codec,
  "cold setup + first encode µs": +microsPerOperation(operation, iterations).toFixed(2),
}));

console.log("Cold setup includes schema/codec construction and the first Person encode.");
console.table(rows);

console.log("Warm Shorn API overhead after the schema identity cache is populated.");
console.table([
  {
    path: "compiled.encode(value)",
    "ops/s": Math.round(1_000_000 / microsPerOperation(() => compiled.encode(person).byteLength, 100_000)),
  },
  {
    path: "encode(schema, value), cached",
    "ops/s": Math.round(1_000_000 / microsPerOperation(() => encode(schema, person).byteLength, 100_000)),
  },
]);
console.log(`Benchmark sink: ${sink}`);
