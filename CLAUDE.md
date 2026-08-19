# Notes for Claude

Read `AGENTS.md` first — setup, layout, and the two rules about changing `src/`. This file
holds what an agent gets wrong that a human contributor would not.

## Releasing: push the tag, never publish

**A pushed tag is the release.** `.github/workflows/release.yml` fires on `v*`, runs
`pnpm check`, asserts the tag matches `package.json`, and publishes to npm. There is no
token: it uses npm trusted publishing, an OIDC exchange that also signs a provenance
attestation only CI can produce.

```sh
# 1. changelog entry for the commits since the last tag, committed on its own
# 2. bench/baseline.json re-recorded if a measured number moved, committed on its own
npm version patch|minor|major   # bumps package.json, commits, tags vX.Y.Z
git push --follow-tags          # this is the publish
gh run list --limit 3           # confirm the Release run went green
```

**Do not run `pnpm release` or `npm publish`.** The `release` script predates the workflow
and survives only for a registry outage. Publishing from a laptop produces an artifact with
no provenance, and without credentials it fails as **`E404` on the `PUT`** — which reads as
"this package does not exist" and sends you hunting for the wrong problem. `npm whoami`
returning 401 is the honest signal that you have no publish auth, and you do not need any.

Never hand-edit the `version` field in `package.json` or an existing `CHANGELOG.md` entry.
`npm version` owns the first. The second is written once, before the bump.

## Verifying a change

`pnpm check` is the gate CI runs and the release runs. `pnpm regress` is separate: it
compares wall-clock throughput and bundle bytes against `bench/baseline.json`.

Throughput rows are noisy — on a busy machine the **unmodified** tree can read 8% down
against its own recording. Before believing a throughput delta, measure the control: stash
the change, run `pnpm regress`, and see what the baseline scores against itself. Bundle-byte
rows are deterministic and can be trusted from a single run.

Re-record the baseline in its own commit, never bundled with the change that moved the
numbers, and say in the message what moved and why.

## Maintainer notes

An untracked `internal/` directory may hold more instructions. Read
`internal/AGENTS.local.md` if it is there; it is the source of truth for release policy,
doc obligations, and benchmark process.
