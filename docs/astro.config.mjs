import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightThemeNext from "starlight-theme-next";
import starlightLlmsTxt from "starlight-llms-txt";
import { AGENT_GUIDANCE } from "./src/lib/agent-metadata";

export default defineConfig({
  site: "https://shorn.dev",
  // The two paths an agent guesses before reading anything. Astro emits a static
  // redirect page for each, which is all GitHub Pages can serve.
  redirects: {
    "/docs": "/getting-started/introduction/",
    "/api": "/api/overview/",
  },
  integrations: [
    starlight({
      plugins: [
        starlightThemeNext(),
        starlightLlmsTxt({
          // llms-small.txt only strips note/tip asides and whitespace by default, and
          // these docs have almost none of either, so it came out within 10% of the full
          // file, which is no choice at all. Abridged here means "how to use shorn",
          // dropping the pages that argue for it or measure it.
          exclude: ["comparisons", "performance/**"],
          details: AGENT_GUIDANCE,
          // Pages are emitted in collator order over their IDs, so left alone the full
          // file opens on `# Errors` and does not reach `# Introduction` until around
          // line 1200: an agent reading top-down meets `DecodeError.offset` long before
          // it learns what shorn is, which is the opposite of the reading order llms.txt
          // recommends. `promote` and `demote` prefix IDs with underscores to move them,
          // earlier pattern meaning earlier in the file, so these two lists are that
          // reading order. They replace the plugin's `promote: ["index*"]`, which matches
          // nothing here: the landing page is `src/pages/index.astro`, not a docs entry.
          promote: [
            "getting-started/introduction",
            "getting-started/**",
            "core-concepts/how-it-works",
            "core-concepts/canonical-bytes",
            "core-concepts/**",
          ],
          demote: ["api/**", "performance/**"],
          customSets: [
            {
              label: "Getting Started and Core Concepts",
              description:
                "What shorn is, why it exists, and how the encode and decode pipeline works.",
              paths: ["getting-started/**", "core-concepts/**"],
            },
            {
              label: "Validators",
              description:
                "Setup for Zod, ArkType, and Valibot, including which Standard interfaces each validator implements.",
              paths: ["validators/**"],
            },
            {
              label: "Schemas",
              description:
                "Supported and rejected schema shapes, plus explicit wire forms for Date, BigInt, Map, and Set.",
              paths: ["schemas/**"],
            },
            {
              label: "Versioning",
              description:
                "Detect schema mismatches with fingerprinted() and select historical codecs by fingerprint.",
              paths: ["versioning/**"],
            },
            {
              label: "Wire Format",
              description:
                "Canonical field order, presence bitmaps, varints, ZigZag, and enum indexes, byte by byte.",
              paths: ["wire-format/**"],
            },
            {
              label: "Comparisons",
              description:
                "How shorn relates to JSON, to schema-driven codecs (Avro, Protobuf, SchemaPack), and to schemaless ones (MessagePack, CBOR).",
              paths: ["comparisons"],
            },
            {
              label: "Performance and Safety",
              description:
                "Measured payload size, throughput, bundle size, startup, memory, and decoder behavior on hostile input.",
              paths: ["performance/**", "hostile-input"],
            },
            {
              label: "API",
              description:
                "Reference for encode/decode, the safe and async variants, compile, fingerprinted, the low-level m builders, and the error types.",
              paths: ["api/**"],
            },
          ],
        }),
      ],
      expressiveCode: {
        themes: ["github-dark"],
      },
      // Ours is `docs/src/pages/404.astro`. Without this, both routes claim /404:
      // Astro drops Starlight's and warns that the clash becomes a hard error.
      disable404Route: true,
      title: "shorn",
      logo: {
        src: "./src/assets/logo.svg",
      },
      description:
        "Compact binary serialization for Zod, Valibot, and ArkType. Keep your validation schema, drop the keys and type tags from the bytes.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/ChiChuRita/shorn",
        },
      ],
      favicon: "/favicon.svg",
      components: {
        ThemeSelect: "./src/components/Empty.astro",
        // Dropping the picker only removed the *control*. ThemeProvider's inline
        // script still read `prefers-color-scheme` and set `data-theme="light"`,
        // which matches Starlight's light block, with equal specificity to the `:root`
        // mapping in custom.css and later in the bundle, so it won. That block
        // repoints the ink ramp (`--sl-color-white: #181818`) but not
        // `--sl-color-bg`, which custom.css pins to #0a0a0a: near-black text on a
        // near-black ground for every light-mode visitor. Drop the script too and
        // no `data-theme` is ever set, so the light block cannot match.
        ThemeProvider: "./src/components/Empty.astro",
        Head: "./src/components/Head.astro",
      },
      // tokens.css first: custom.css maps Starlight's ramp onto the tokens it
      // declares, and the landing page imports the same file directly.
      customCss: ["./src/styles/tokens.css", "./src/styles/custom.css"],
      // Six groups, five children at most, and nothing top-level that is a bare page or
      // an outbound file. The previous eleven entries of five different kinds overran
      // the sidebar's own scroll container at 1440x900: it stopped at "Schema Changes",
      // so the whole API group sat below the fold and the reference read as missing to
      // the reader most likely to want it. Regrouping alone did not fix that, since 33
      // expanded rows still want 1138px of an 836px pane, hence `collapsed` on every
      // group: Starlight opens the one holding the current page, so a reader sees where
      // they are plus the other five section names, and the pane never scrolls.
      // Labels and nesting only. Every slug below is the slug it was, because the pages
      // cross-link each other by path and the site is live.
      sidebar: [
        {
          label: "Getting Started",
          collapsed: true,
          items: [
            { label: "Introduction", slug: "getting-started/introduction" },
            { label: "Installation", slug: "getting-started/installation" },
            { label: "Quick Start", slug: "getting-started/quick-start" },
            { label: "Using Payloads", slug: "getting-started/using-payloads" },
            { label: "Comparisons", slug: "comparisons" },
          ],
        },
        {
          label: "Schemas",
          collapsed: true,
          items: [
            { label: "Supported Types", slug: "schemas/supported-types" },
            { label: "Rejected Shapes", slug: "schemas/rejected-shapes" },
            {
              label: "Date, BigInt, Map, Set",
              slug: "schemas/rich-types",
            },
            {
              // Three pages, one skeleton each (extra properties, rich types, version
              // note), and a reader needs exactly one of them. Collapsed they cost one
              // row instead of four; Starlight opens the group on its own pages.
              label: "Validators",
              collapsed: true,
              items: [
                { label: "Zod", slug: "validators/zod" },
                { label: "ArkType", slug: "validators/arktype" },
                { label: "Valibot", slug: "validators/valibot" },
              ],
            },
          ],
        },
        {
          // "Wire Format" is the name the prose and the llms-txt set above use, and it
          // is what someone searching the sidebar types. It also puts the first segment
          // of /wire-format/layout/ on screen, which "Byte Layout" alone never did.
          label: "Wire Format",
          collapsed: true,
          items: [
            { label: "How It Works", slug: "core-concepts/how-it-works" },
            { label: "Canonical Bytes", slug: "core-concepts/canonical-bytes" },
            { label: "Byte Layout", slug: "wire-format/layout" },
          ],
        },
        {
          label: "Production",
          collapsed: true,
          items: [
            { label: "Validation", slug: "core-concepts/validation" },
            {
              label: "Compilation and Caching",
              slug: "core-concepts/compile-and-caching",
            },
            { label: "Wire Fingerprints", slug: "versioning/fingerprinting" },
            { label: "Schema Changes", slug: "versioning/schema-evolution" },
            { label: "Hostile Input", slug: "hostile-input" },
          ],
        },
        {
          label: "Performance",
          collapsed: true,
          items: [
            { label: "Payload Size", slug: "performance/size" },
            { label: "Throughput", slug: "performance/throughput" },
            { label: "Footprint", slug: "performance/footprint" },
          ],
        },
        {
          label: "API",
          collapsed: true,
          items: [
            { label: "API Overview", slug: "api/overview" },
            { label: "Functions", slug: "api/functions" },
            { label: "m Builders", slug: "api/m" },
            { label: "Errors", slug: "api/errors" },
          ],
        },
        // No "LLM Docs" entry. It pointed at /llms-full.txt, 200 KB of plain text that
        // no human wants, and machines never needed the sidebar: Head.astro emits
        // <link rel="alternate" type="text/markdown" href="/llms.txt"> on every page.
      ],
    }),
  ],
});
