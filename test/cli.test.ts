import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CliIo } from "../src/cli.js";
import { run } from "../src/cli.js";

// Outside the repo on purpose: the fixtures are modules the CLI imports by path, and a
// temp directory keeps them from being mistaken for part of the tree. `zod` still
// resolves, because Node walks up from the importer to the pnpm store.
const dir = mkdtempSync(join(tmpdir(), "shorn-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fixture(name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
}

const PERSON = `
import { z } from "zod";
export const Person = z.object({
  name: z.string(),
  age: z.int().nonnegative(),
  sex: z.enum(["M", "F", "X"]),
});
`;

const person = fixture(
  "person.mjs",
  `import { z } from "zod";
   export const Person = z.object({ name: z.string(), age: z.int().nonnegative() });
   export const Tag = z.string();`,
);
const soleExport = fixture("sole.mjs", PERSON);
const withDefault = fixture(
  "default.mjs",
  `${PERSON}
   export default z.object({ id: z.int() });`,
);
const noExports = fixture("empty.mjs", "const unused = 1;\nvoid unused;\n");
const notASchema = fixture("plain.mjs", "export default { hello: 'world' };");
const codec = fixture(
  "codec.mjs",
  `import { z } from "zod";
   import { compile, fingerprinted } from "${join(import.meta.dirname, "../src/index.ts")}";
   export default fingerprinted(compile(z.object({ n: z.int() })), { bytes: 4 });`,
);

/** One command, with stdin as a string and stdout collected as bytes. */
async function cli(
  args: string,
  stdin: Uint8Array | string = "",
): Promise<{ code: number; out: Uint8Array; text: string; err: string }> {
  const written: number[] = [];
  let err = "";
  const io: CliIo = {
    cwd: dir,
    readStdin: () =>
      Promise.resolve(typeof stdin === "string" ? new TextEncoder().encode(stdin) : stdin),
    writeStdout: (bytes) => void written.push(...bytes),
    writeStderr: (text) => void (err += text),
  };
  const code = await run(args === "" ? [] : args.split(" "), io);
  const out = new Uint8Array(written);
  return { code, out, text: new TextDecoder().decode(out), err };
}

describe("shorn CLI", () => {
  it("round trips a value through raw bytes on stdout", async () => {
    const encoded = await cli(`encode ${person} --export Person`, '{"name":"Grace","age":45}');
    expect(encoded.code).toBe(0);
    expect(encoded.err).toBe("");
    // The same eight-byte layout the README documents, minus the enum field.
    expect([...encoded.out]).toEqual([0x2d, 0x05, 0x47, 0x72, 0x61, 0x63, 0x65]);

    const decoded = await cli(`decode ${person} --export Person`, encoded.out);
    expect(decoded.code).toBe(0);
    expect(decoded.text).toBe('{"name":"Grace","age":45}\n');
  });

  it("round trips through base64 text, so the bytes survive a terminal", async () => {
    const encoded = await cli(
      `encode ${person} --export Person --base64`,
      '{"name":"Grace","age":45}',
    );
    expect(encoded.code).toBe(0);
    expect(encoded.text).toBe("LQVHcmFjZQ==\n");

    // Trailing newline and all, as a shell pipeline hands it over.
    const decoded = await cli(`decode ${person} --export Person --base64`, encoded.text);
    expect(decoded.code).toBe(0);
    expect(decoded.text).toBe('{"name":"Grace","age":45}\n');
  });

  it("prefers the default export, then the only export", async () => {
    const byDefault = await cli(`encode ${withDefault} --base64`, '{"id":7}');
    expect(byDefault.code).toBe(0);
    expect(byDefault.text).toBe("Dg==\n");

    const sole = await cli(`encode ${soleExport} --base64`, '{"name":"A","age":1,"sex":"F"}');
    expect(sole.code).toBe(0);
    expect(sole.text).toBe("AQFBAA==\n");
  });

  it("names the exports when it cannot choose one", async () => {
    const ambiguous = await cli(`encode ${person}`, "{}");
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toContain("more than one named export");
    expect(ambiguous.err).toContain("Person, Tag");

    const missing = await cli(`encode ${person} --export Nope`, "{}");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('no export named "Nope"');

    const empty = await cli(`encode ${noExports}`, "{}");
    expect(empty.code).toBe(1);
    expect(empty.err).toContain("no named exports");
  });

  it("takes a shorn codec as well as a validator", async () => {
    const encoded = await cli(`encode ${codec} --base64`, '{"n":300}');
    expect(encoded.code).toBe(0);

    // Empty input carries no fingerprint, so the codec's own check is what refuses it.
    const empty = await cli(`decode ${codec}`, new Uint8Array());
    expect(empty.code).toBe(1);

    const back = await cli(`decode ${codec} --base64`, encoded.text);
    expect(back.text).toBe('{"n":300}\n');
  });

  it("exits 1 on bad input, without a stack trace", async () => {
    const badJson = await cli(`encode ${person} --export Person`, "{not json");
    expect(badJson.code).toBe(1);
    expect(badJson.err).toMatch(/^shorn: .*\n$/s);

    const invalid = await cli(`encode ${person} --export Person`, '{"name":"A","age":-1}');
    expect(invalid.code).toBe(1);
    expect(invalid.err).toContain("age");

    const truncated = await cli(`decode ${person} --export Person`, new Uint8Array([0x2d]));
    expect(truncated.code).toBe(1);

    const notSchema = await cli(`encode ${notASchema}`, "{}");
    expect(notSchema.code).toBe(1);
    expect(notSchema.err).toContain("Expected a Standard Schema");

    const noModule = await cli(`encode ${join(dir, "absent.mjs")}`, "{}");
    expect(noModule.code).toBe(1);
  });

  it("exits 2 on a command line it cannot read", async () => {
    for (const args of ["", "burn ./x.mjs", `encode`, `encode ${person} extra`, "--nope"]) {
      const result = await cli(args);
      expect({ args, code: result.code }).toEqual({ args, code: 2 });
      expect(result.err.startsWith("shorn: ")).toBe(true);
      expect(result.out.length).toBe(0);
    }
  });

  it("prints help and the version on stdout, and exits 0", async () => {
    const help = await cli("--help");
    expect(help.code).toBe(0);
    expect(help.err).toBe("");
    // Every flag the docs promise is in the text a user is told to read.
    for (const flag of ["encode", "decode", "--export", "--base64", "--help", "--version"]) {
      expect(help.text).toContain(flag);
    }

    const version = await cli("-v");
    const declared = JSON.parse(
      readFileSync(join(import.meta.dirname, "../package.json"), "utf8"),
    ) as { version: string };
    expect(version.text).toBe(`${declared.version}\n`);
    expect(version.code).toBe(0);
  });

  it("reads stdin only when a command needs it", async () => {
    // --help before a pipe is open must not hang, so `run` may not touch stdin here.
    const io: CliIo = {
      cwd: dir,
      readStdin: () => Promise.reject(new Error("stdin was read")),
      writeStdout: () => {},
      writeStderr: () => {},
    };
    expect(await run(["--help"], io)).toBe(0);
    expect(await run(["--version"], io)).toBe(0);
    expect(await run([], io)).toBe(2);
  });
});
