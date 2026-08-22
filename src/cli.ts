import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { EncodableStandardSchema, Schema } from "./index.js";
import { compile } from "./index.js";

/**
 * Everything the CLI touches outside itself. It is an argument rather than a reach for
 * `process` so the tests can drive the real command surface in-process: `pnpm check`
 * runs the tests before the build, so no test may spawn the bin or read `dist/`.
 */
export interface CliIo {
  /** Module paths resolve against this, so a relative path means what the shell meant. */
  readonly cwd: string;
  /** Called only by `encode` and `decode`, so `--help` never waits on a pipe. */
  readonly readStdin: () => Promise<Uint8Array>;
  readonly writeStdout: (bytes: Uint8Array) => void;
  readonly writeStderr: (text: string) => void;
}

/** 0 success, 1 failure, 2 a command line shorn could not read. */
const OK = 0;
const FAILED = 1;
const USAGE = 2;

const HELP = `shorn: encode and decode from the shell

Usage:
  shorn encode <module> [--export <name>] [--base64]
  shorn decode <module> [--export <name>] [--base64]

Commands:
  encode           read a JSON value on stdin, write encoded bytes on stdout
  decode           read encoded bytes on stdin, write a JSON value on stdout

Options:
  --export <name>  use this named export instead of the default
  --base64         put base64 text on the byte side, not raw bytes
  -h, --help       print this help
  -v, --version    print the shorn version

<module> is a file that exports a Zod or ArkType schema, or a shorn codec. shorn
imports it, so Node has to be able to run it. Without --export, shorn takes the
default export, or the only export when the module has exactly one.

Examples:
  echo '{"name":"Grace","age":45}' | shorn encode ./person.js --export Person > p.bin
  shorn decode ./person.js --export Person < p.bin
  echo '{"name":"Grace","age":45}' | shorn encode ./person.js --export Person --base64

Exit codes: 0 success, 1 failure, 2 bad usage.
`;

/**
 * The version comes from the package.json beside the bundle rather than a baked-in
 * constant, so `npm version` stays the only thing that writes it. `../` is the package
 * root from `src/cli.ts` and from `dist/cli.mjs` alike.
 */
function packageVersion(): string {
  const path = new URL("../package.json", import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const version = (parsed as { version?: unknown }).version;
  return typeof version === "string" ? version : "unknown";
}

/**
 * Default export, then the sole export. Listing the names in the failure is the point:
 * the fix is always `--export <one of these>`.
 */
function pickExport(module: Record<string, unknown>, name: string | undefined): unknown {
  const names = Object.keys(module);
  if (name !== undefined) {
    if (!(name in module)) {
      throw new Error(`the module has no export named "${name}". It exports: ${list(names)}`);
    }
    return module[name];
  }
  if ("default" in module) return module["default"];
  const only = names[0];
  if (names.length === 1 && only !== undefined) return module[only];
  const cause = names.length === 0 ? "no named exports" : "more than one named export";
  throw new Error(
    `the module has no default export and ${cause}, so pass --export <name>. ` +
      `It exports: ${list(names)}`,
  );
}

function list(names: readonly string[]): string {
  return names.length === 0 ? "nothing" : names.join(", ");
}

/**
 * A codec passes through. Anything else goes to `compile`, which owns the message for a
 * value that is not a Standard Schema.
 *
 * Duck-typed rather than `instanceof Schema`, because a globally installed CLI and the
 * copy of the library the imported module built its codec from are two module
 * instances, and an identity check across them is always false. A Standard Schema is
 * ruled out first, so a validator that happens to expose `encode` is still compiled.
 */
function toCodec(exported: unknown): Schema<unknown> {
  if (
    typeof exported === "object" &&
    exported !== null &&
    !("~standard" in exported) &&
    typeof (exported as Schema<unknown>).encode === "function" &&
    typeof (exported as Schema<unknown>).decode === "function"
  ) {
    return exported as Schema<unknown>;
  }
  return compile(exported as EncodableStandardSchema);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One command run. Returns the exit code instead of calling `process.exit`, so the
 * caller can let Node flush a piped stdout before the process ends.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const write = (text: string): void => io.writeStdout(new TextEncoder().encode(text));

  let values: { export?: string; base64?: boolean; help?: boolean; version?: boolean };
  let positionals: string[];
  try {
    // parseArgs already phrases the failure for an unknown option or a missing value.
    ({ values, positionals } = parseArgs({
      args: [...argv],
      options: {
        export: { type: "string" },
        base64: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
      allowPositionals: true,
    }));
  } catch (error) {
    io.writeStderr(`shorn: ${messageOf(error)}\nRun shorn --help.\n`);
    return USAGE;
  }

  if (values.help === true) {
    write(HELP);
    return OK;
  }
  if (values.version === true) {
    write(`${packageVersion()}\n`);
    return OK;
  }

  const [command, modulePath, ...extra] = positionals;
  if (command === undefined) {
    io.writeStderr(`shorn: no command. Run shorn --help.\n`);
    return USAGE;
  }
  if (command !== "encode" && command !== "decode") {
    io.writeStderr(`shorn: unknown command "${command}". Expected encode or decode.\n`);
    return USAGE;
  }
  if (modulePath === undefined) {
    io.writeStderr(`shorn: ${command} needs a module path. Run shorn --help.\n`);
    return USAGE;
  }
  if (extra.length > 0) {
    io.writeStderr(`shorn: unexpected argument "${extra[0]}". Run shorn --help.\n`);
    return USAGE;
  }

  try {
    const url = pathToFileURL(resolve(io.cwd, modulePath)).href;
    const module = (await import(url)) as Record<string, unknown>;
    const codec = toCodec(pickExport(module, values.export));

    if (command === "encode") {
      const value: unknown = JSON.parse(new TextDecoder().decode(await io.readStdin()));
      const bytes = codec.encode(value);
      if (values.base64 === true) write(`${Buffer.from(bytes).toString("base64")}\n`);
      else io.writeStdout(bytes);
    } else {
      const input = await io.readStdin();
      // A fresh copy either way: base64 comes out of the Buffer pool at a non-zero
      // byte offset, and a decoder reading the whole backing buffer would see the pool.
      const bytes = new Uint8Array(
        values.base64 === true
          ? Buffer.from(new TextDecoder().decode(input).trim(), "base64")
          : input,
      );
      write(`${JSON.stringify(codec.decode(bytes))}\n`);
    }
    return OK;
  } catch (error) {
    io.writeStderr(`shorn: ${messageOf(error)}\n`);
    return FAILED;
  }
}
