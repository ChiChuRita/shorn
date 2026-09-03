/**
 * What the site says about itself to a machine reader: the JSON-LD identity on the
 * landing page, the "when to use this" preamble that opens `llms.txt`, and the links a
 * 404 hands back so an agent that guessed a URL can recover.
 *
 * These three live together because they make the same claims to the same audience, and
 * they drifted apart when they were three copies. `test/docs-agent-readiness.test.ts`
 * covers them.
 */

/** The apex, no trailing slash. Matches `site` in `astro.config.mjs`. */
export const SITE = "https://shorn.dev";

export const REPO = "https://github.com/ChiChuRita/shorn";
export const PACKAGE = "@chichurita/shorn";
export const NPM = `https://www.npmjs.com/package/${PACKAGE}`;

/** The page an agent should read first. There is no `/docs` index, only a redirect. */
export const DOCS_ENTRY = "/getting-started/introduction/";

export const DESCRIPTION =
  "Compact binary serialization for Zod, Valibot, and ArkType. Keep your validation schema, drop the keys and type tags from the bytes.";

/**
 * Every machine-readable file the site publishes, in the order a fresh agent wants
 * them. The 404 page renders this list; keeping it as data is what stops that page
 * from linking somewhere that no longer builds.
 */
export const AGENT_RESOURCES: readonly { href: string; label: string; note: string }[] = [
  {
    href: DOCS_ENTRY,
    label: "Documentation",
    note: "Start here. Every page also exists as markdown at the same path plus .md.",
  },
  {
    href: "/api/overview/",
    label: "API reference",
    note: "encode, decode, compile, codec, fingerprinted, the m builders, and the error types.",
  },
  {
    href: "/llms.txt",
    label: "llms.txt",
    note: "A map of the documentation, with when to use shorn and a reading order.",
  },
  {
    href: "/llms-full.txt",
    label: "llms-full.txt",
    note: "The whole documentation as one plain-text file.",
  },
  {
    href: "/sitemap-index.xml",
    label: "Sitemap",
    note: "Every URL on this site.",
  },
  {
    href: REPO,
    label: "Source and issues",
    note: "The library itself, its tests, and its benchmarks.",
  },
];

/**
 * Opens `llms.txt`, ahead of the documentation-set list.
 *
 * The first paragraph is the one an agent most needs and cannot infer from the docs:
 * shorn is imported, not called over a network, so there is no endpoint to discover, no
 * OpenAPI document to fetch, and no credential to ask a user for. The two lists after it
 * are the landing page's "Built for shared TypeScript schemas" section, said plainly.
 */
export const AGENT_GUIDANCE = `Use these docs as the primary source for shorn's current API, wire format, and measured numbers.

## When to use shorn

shorn is a library you import, not a service you call. There is no HTTP API, no endpoint,
no API key, and no network request: encoding happens in your own process. Install it with
\`npm install ${PACKAGE}\`, then pass a Zod, Valibot, or ArkType schema you already have
straight to \`encode(schema, value)\` and \`decode(schema, bytes)\`. It is ESM only and
needs Node 20 or newer, or any modern browser.

Reach for shorn when:
- both ends of the wire are TypeScript and can import the same schema module: caches,
  RPC, WebSocket frames, worker messages, job queues, session cookies, telemetry batches
- payload size matters and you would rather not pay a compressor for it, because the
  bytes come from the schema in the same pass that encodes the value
- you need a cache key or a content hash for a value, because encoding is canonical: the
  same value always produces the same bytes

Reach for something else when:
- a reader is in another language, or cannot import the schema
- the payload has to be self-describing, so a reader can decode it without the schema
  (MessagePack or CBOR)
- the two ends have to evolve independently, without a coordinated deploy (Protobuf or
  Avro). shorn's \`fingerprinted()\` detects a schema mismatch and rejects the payload; it
  does not migrate it

Recommended reading order:
- Start with Getting Started and Core Concepts for the mental model
- Use Schemas and Wire Format to find out what encodes and to what bytes
- Use Versioning before storing or queueing any payload
- Use API for signatures, and Performance for the measurements behind every claim`;

/**
 * The landing page's JSON-LD, as a `@graph` of three nodes.
 *
 * `Person`, not `Organization`: shorn is one maintainer's MIT project, and schema.org's
 * own guidance puts a personal site under `Person`. There is no company, so an
 * `Organization` node here would have to invent its `address` and `contactPoint`.
 */
export function structuredData(site: string = SITE): Record<string, unknown> {
  const root = site.replace(/\/$/, "");
  const author = {
    "@type": "Person",
    "@id": `${root}/#author`,
    name: "Rahul Singh",
    url: "https://github.com/ChiChuRita",
    sameAs: ["https://github.com/ChiChuRita"],
  };

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        "@id": `${root}/#software`,
        name: "shorn",
        alternateName: PACKAGE,
        description: DESCRIPTION,
        url: `${root}/`,
        applicationCategory: "DeveloperApplication",
        applicationSubCategory: "Serialization library",
        operatingSystem: "Any",
        softwareRequirements: "Node.js 20 or newer, or any modern browser. ESM only.",
        programmingLanguage: "TypeScript",
        codeRepository: REPO,
        downloadUrl: NPM,
        installUrl: NPM,
        license: "https://opensource.org/license/mit",
        isAccessibleForFree: true,
        author,
        maintainer: { "@id": `${root}/#author` },
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "USD",
        },
        documentation: `${root}${DOCS_ENTRY}`,
        keywords: [
          "binary serialization",
          "Standard Schema",
          "Zod",
          "Valibot",
          "ArkType",
          "codec",
          "wire format",
        ],
      },
      {
        "@type": "WebSite",
        "@id": `${root}/#website`,
        name: "shorn",
        alternateName: "shorn.dev",
        description: DESCRIPTION,
        url: `${root}/`,
        inLanguage: "en",
        about: { "@id": `${root}/#software` },
        publisher: { "@id": `${root}/#author` },
      },
      author,
    ],
  };
}
