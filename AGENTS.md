# Contributing to shorn

Notes for anyone — human or agent — working on this repo from a clone.

shorn turns a Standard Schema you already have (Zod, Valibot, ArkType) into a compact
binary codec. The library is the repo root; `docs/` is a separate Astro workspace
package for <https://shorn.dev>.

## Setup

Requires **pnpm** and **Node 22.13+** to install. The published package supports Node
20 — that floor is CI's job to enforce, not yours to develop against.

```sh
pnpm install
```

## The one command that matters

```sh
pnpm check
```

Typecheck, tests, build, and a packaging lint, in that order. **A change is not
finished until this is green.** CI runs exactly this, so a green local `check` is a
good predictor of a green PR.

Narrower loops while you work:

```sh
pnpm test                          # all tests
pnpm test test/envelope.test.ts    # one file
pnpm typecheck
pnpm build
pnpm examples                      # runs examples/, which assert on their own output
```

There is no lint or format step. Match the surrounding code.

## Layout

| Path | What |
| --- | --- |
| `src/core.ts` | the `m` builders, the wire format, `Reader`/`Writer` |
| `src/standard.ts` | the Standard Schema bridge — `compile`, `encode`, `decode`, `codec` |
| `src/envelope.ts` | `fingerprinted()` and the mismatch prefix |
| `test/` | vitest; `property.test.ts` and `fuzz.test.ts` are generative |
| `bench/` | benchmarks against msgpackr, cbor-x, Avro, Protobuf, SchemaPack, JSON |
| `examples/` | runnable, self-asserting; they double as documentation |

`dist/` is generated and gitignored. Never commit it, and never edit the `version`
field in `package.json` or `CHANGELOG.md` — tooling owns both.

## Two things to know before you change `src/`

**The wire format is a compatibility promise.** Payloads are tagless and positional: a
value carries no key, no type tag, and no version, so field order and marker layout
*are* the format. Changing the bytes a given schema produces breaks every payload
already written by an earlier version. If that is what your change does, say so
explicitly in the PR — and if you are not sure whether it does, open an issue before
writing much code.

**The comments in `src/core.ts` are load-bearing.** Much of that file looks
over-engineered and is not: the odd-looking parts are there for measured reasons, and
the comments record which. Read the comment before simplifying the code under it. If a
measurement is what justified the code, a measurement is what should retire it —
`pnpm regress` compares against a recorded baseline.

## Submitting a change

Say in the PR description what a user of the package would notice, and classify it by
effect on users rather than by diff size — new API is a minor, a fix that keeps the same
bytes is a patch, and anything that changes the bytes or breaks existing payloads is
breaking, however small the diff. That note becomes the release entry, so say *why* as
well as what. Changes confined to `bench/`, `docs/`, or CI need no note.

There is no changeset step. shorn is a single package, so the changelog is written by hand
at release time from the commits. Publishing itself is not manual: a maintainer pushes a
`v*` tag and `.github/workflows/release.yml` runs `pnpm check` and publishes. Nothing about
a contributed change needs to touch that.

Tests are expected with a behaviour change. Match the file that already covers the area
rather than adding a new one.

## Maintainers

An untracked `internal/` directory may hold additional local instructions. Read
`internal/AGENTS.local.md` if it is present; if it is not, this file is the whole of it.
