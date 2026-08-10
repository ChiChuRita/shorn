/**
 * The value for the `document` fixture, kept out of `fixtures.mjs` because that file
 * holds schemas only and every bench supplies its own values.
 *
 * Deterministic, no RNG: the same bytes on every run, so a size row is a size row.
 * Proportions are matched to the document that exposed the gap — around 7.5 KB, three
 * quarters of it string content, ASCII throughout. ASCII deliberately: the published
 * decode caveat blamed Unicode, and the fixture that beat us had no multi-byte
 * character in it. The cost is the number of strings, not what is in them.
 */

const LOREM =
  "the quick brown fox jumps over the lazy dog while the parser reads one string at a time";

const sentence = (index, words) =>
  LOREM.split(" ")
    .slice(index % 6, (index % 6) + words)
    .join(" ");

export const documentValue = Object.freeze({
  metadata: {
    abstract: `${sentence(1, 14)}. ${sentence(3, 12)}. ${sentence(5, 16)}.`,
    authors: ["Ada Lovelace", "Grace Hopper", "Alan Turing", "Barbara Liskov"],
    canonicalUrl: null,
    created: "2026-03-14T09:26:53.589Z",
    digitized: true,
    doi: null,
    edition: null,
    identifier: "DOC-2026-0031415",
    issn: null,
    issue: null,
    keywords: ["serialization", "schema", "binary", "wire format", "validation"],
    language: "en",
    license: null,
    pages: null,
    publisher: "Journal of Applied Byte Counting",
    retracted: false,
    revision: 7,
    series: null,
    summary: `${sentence(2, 18)}. ${sentence(4, 14)}.`,
    title: "On the elision of field names in schema-guided binary encodings",
    volume: null,
    year: 2026,
  },
  id: 179_246_831,
  measures: Array.from({ length: 6 }, (_, index) => ({
    count: 100 + index * 37,
    label: `measure ${index} — ${sentence(index, 5)}`,
    mean: 12.5 + index * 1.75,
    stddev: 0.5 + index / 8,
    unit: index % 2 === 0 ? "ms" : "%",
  })),
  name: "on-the-elision-of-field-names",
  references: Array.from(
    { length: 8 },
    (_, index) => `[${index + 1}] ${sentence(index, 9)}, ${2015 + index}`,
  ),
  score: 22.084_654_254_966_498,
  // Four key sets in one array, cycling, so the presence bitmap changes per element
  // and no element shape can be assumed from the first one.
  sections: Array.from({ length: 9 }, (_, index) => {
    const base = {
      id: `s${index}`,
      terms: [
        [`term-${index}`, `alias-${index}`],
        [`concept-${index}`],
      ],
    };
    switch (index % 4) {
      case 0:
        return { ...base, title: `Section ${index}`, body: sentence(index, 17), depth: 1 };
      case 1:
        return { ...base, title: `Section ${index}`, ordinal: index, score: index / 3 };
      case 2:
        return { ...base, anchor: `#section-${index}`, body: sentence(index, 13) };
      default:
        return base;
    }
  }),
  tags: ["preprint", "open-access", "peer-reviewed"],
});
