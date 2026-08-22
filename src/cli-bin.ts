#!/usr/bin/env node
import { Buffer } from "node:buffer";
import process from "node:process";
import { run } from "./cli.js";

/**
 * The real streams, kept out of `cli.ts` so `run` stays callable from a test. Stdin is
 * read whole because both commands need the entire value before they can start.
 */
process.exitCode = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  readStdin: async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
    return Buffer.concat(chunks);
  },
  writeStdout: (bytes) => {
    process.stdout.write(bytes);
  },
  writeStderr: (text) => {
    process.stderr.write(text);
  },
});
