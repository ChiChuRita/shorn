---
title: CLI
description: Encode and decode from a shell, against a schema module you already have.
---

Installing the package puts a `shorn` command on the path. It encodes and decodes against a module that exports a schema, so a script or an agent can produce and read payloads without writing an integration.

```sh
npm install @chichurita/shorn zod
npx shorn --help
```

## Encode and decode

```sh
shorn encode <module> [--export <name>] [--base64]
shorn decode <module> [--export <name>] [--base64]
```

`encode` reads a JSON value on stdin and writes the encoded bytes on stdout. `decode` reads encoded bytes on stdin and writes a JSON value on stdout. Both read stdin to the end, so give them a pipe or a redirect.

Given `person.mjs`:

```js
import { z } from "zod";

export const Person = z.object({
  name: z.string(),
  age: z.int().nonnegative(),
  sex: z.enum(["M", "F", "X"]),
});
```

The round trip:

```sh
$ echo '{"name":"Grace","age":45,"sex":"F"}' | shorn encode ./person.mjs --export Person > person.bin
$ xxd person.bin
00000000: 2d05 4772 6163 6500                      -.Grace.
$ shorn decode ./person.mjs --export Person < person.bin
{"name":"Grace","age":45,"sex":"F"}
```

Validation runs on both sides, the same as it does through the library. The bytes are the same bytes: this is `encode` and `decode` with a shell around them, not a second format.

## `--base64`

Raw bytes down a pipe are hard to read and easy to corrupt by pasting. `--base64` puts base64 text on the byte side of both commands, so a payload can travel through a terminal, a JSON field, or an environment variable.

```sh
$ echo '{"name":"Grace","age":45,"sex":"F"}' | shorn encode ./person.mjs --export Person --base64
LQVHcmFjZQA=
$ echo 'LQVHcmFjZQA=' | shorn decode ./person.mjs --export Person --base64
{"name":"Grace","age":45,"sex":"F"}
```

## Which export shorn uses

`<module>` is a path, resolved against the current directory, to a file that Node can import. A `.mjs` file, or a `.js` file in a package with `"type": "module"`, always works. A `.ts` file works on a Node that strips types (22.18 and newer); on anything older, point at compiled JavaScript.

The module may export a validator schema (Zod or ArkType) or a shorn codec from `compile()`, `fingerprinted()`, or the `m` builders. Valibot carries its structure separately, so pass a compiled codec rather than the raw schema:

```js
import * as v from "valibot";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { compile } from "@chichurita/shorn";

const schema = v.object({ n: v.number() });
export default compile(schema, toStandardJsonSchema(schema));
```

Which export is used, in order:

1. `--export <name>`, if given.
2. The default export.
3. The only export, when the module has exactly one.

Anything else is an error that names what the module does export, because the fix is always `--export <one of those>`. For a `schemas.mjs` exporting both `Person` and `Sex`:

```sh
$ echo '{}' | shorn encode ./schemas.mjs
shorn: the module has no default export and more than one named export, so pass --export <name>. It exports: Person, Sex
```

A default export wins over named exports, so `--export` is the only way to reach a named export in a module that has both.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success, including `--help` and `--version` |
| 1 | the module, the schema, or the payload was no good |
| 2 | shorn could not read the command line |

Errors go to stderr as one plain line, and nothing goes to stdout, so a failed run never puts half a payload into a file.

```sh
$ echo '{"name":"Grace","age":-1,"sex":"F"}' | shorn encode ./person.mjs --export Person
shorn: age: Too small: expected number to be >=0 at age
$ echo $?
1
$ shorn burn ./person.mjs
shorn: unknown command "burn". Expected encode or decode.
$ echo $?
2
```

## Everything else

```sh
shorn --help      # or -h
shorn --version   # or -v
```

There is nothing else. The CLI is a thin wrapper on [`encode` and `decode`](/api/functions/): for anything the two commands do not cover, import the library.
