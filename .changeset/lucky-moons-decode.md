---
"shorn": patch
---

Decode strings through Node's own UTF-8 decoder where there is one. The wire bytes
are unchanged.

`TextDecoder.decode` costs a flat 59-70ns on short input, and a document-shaped
payload pays it once per string — three quarters of the decode time on the fixture
that exposed this. `Buffer.prototype.utf8Slice` does the same work 45% cheaper at
every length measured, and it runs on any `Uint8Array`, so nothing is allocated per
call:

| bytes | TextDecoder | utf8Slice + guard |
| ---: | ---: | ---: |
| 4 | 59.0 ns | 31.1 ns |
| 16 | 61.5 ns | 34.7 ns |
| 64 | 65.0 ns | 38.2 ns |
| 512 | 103.0 ns | 75.3 ns |

Document decode is 10.5% faster and the Unicode string 3.8%. It is a global lookup
rather than an import, so a browser, a worker or a Deno without the Node shim finds
nothing and keeps the `TextDecoder` path; Bun and Deno's Node compatibility both
provide it.

**Malformed input still throws.** `utf8Slice` substitutes U+FFFD where the fatal
`TextDecoder` throws, so the result is checked for U+FFFD and handed to the fatal
decoder when one is present — a result without one *proves* the input was well
formed. `String.prototype.indexOf` is a native scan, which is why this beats an
explicit ASCII pre-scan (that lost to `TextDecoder` past 64 bytes). A payload that
legitimately contains U+FFFD takes the same second pass and comes back intact
rather than being mistaken for corruption. Both cases are covered by tests.

Costs 183 minified and 77 gzip bytes, 1.6% on the `m`-only row and over the 1%
gate. Argued rather than assumed, on the precedent of the ASCII fast path (~480
minified for 17-29%): this is a better ratio, it applies to every string past the
8-byte fast path, and it lands on the server side where decode volume actually is.
The `m` row keeps a ~24% gzip margin over `@msgpack/msgpack`.

Widening the JS `String.fromCharCode` path past 8 bytes was measured and dropped:
a simple loop costs 77ns at 16 bytes against `utf8Slice`'s 35, and a 16-wide
batched loop only wins at exactly-aligned lengths. The existing 8-byte gate stands.
