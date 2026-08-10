---
"shorn": patch
---

`require("shorn")` now resolves instead of throwing `ERR_PACKAGE_PATH_NOT_EXPORTED`.

The `exports` map declared only an `import` condition, so a CommonJS caller was
refused by the resolver before Node ever got to decide whether it could load an
ES module — including on Node 22, where `require` of an ESM graph works fine.
The condition map now also answers `require`, pointing at the same ESM build.

There is still no CommonJS build and there is no plan for one. What changed is
which Node versions can reach the ESM build: 20.19+ and 22.12+ load it through
`require` directly, and older versions get `ERR_REQUIRE_ESM`, which at least
names the real constraint. `await import("shorn")` remains the portable form.

Found while running shorn through msgpackr's benchmark harness, which is
CommonJS: the codec that advertises itself as a one-line drop-in could not be
required at all.
