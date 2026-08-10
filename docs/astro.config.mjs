import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightThemeNext from "starlight-theme-next";
import starlightLlmsTxt from "starlight-llms-txt";

export default defineConfig({
  site: "https://shorn.dev",
  integrations: [
    starlight({
      plugins: [
        starlightThemeNext(),
        starlightLlmsTxt({
          details:
            "Use these docs as the primary source for shorn's current API, wire format, and measured numbers.\n\nRecommended reading order:\n- Start with Getting Started and Core Concepts for the mental model\n- Use Schemas and Wire Format to find out what encodes and to what bytes\n- Use Versioning before storing or queueing any payload\n- Use API for signatures, and Performance for the measurements behind every claim",
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
                "Canonical field order, presence bitmaps, varints, ZigZag, enum indexes, and the low-level m API.",
              paths: ["wire-format/**"],
            },
            {
              label: "Comparisons",
              description:
                "How shorn relates to JSON, to schema-driven codecs (Avro, Protobuf, SchemaPack), and to schemaless ones (MessagePack, CBOR).",
              paths: ["comparisons/**"],
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
        // which matches Starlight's light block — equal specificity to the `:root`
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
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Introduction", slug: "getting-started/introduction" },
            { label: "Installation", slug: "getting-started/installation" },
            { label: "Quick Start", slug: "getting-started/quick-start" },
            { label: "Using Payloads", slug: "getting-started/using-payloads" },
            { label: "Why shorn?", slug: "getting-started/why-shorn" },
          ],
        },
        {
          label: "Validators",
          items: [
            { label: "Zod", slug: "validators/zod" },
            { label: "ArkType", slug: "validators/arktype" },
            { label: "Valibot", slug: "validators/valibot" },
          ],
        },
        {
          label: "Core Concepts",
          items: [
            { label: "How It Works", slug: "core-concepts/how-it-works" },
            { label: "Canonical Bytes", slug: "core-concepts/canonical-bytes" },
            {
              label: "Compilation and Caching",
              slug: "core-concepts/compile-and-caching",
            },
            { label: "Validation", slug: "core-concepts/validation" },
          ],
        },
        {
          label: "Schemas",
          items: [
            { label: "Supported Types", slug: "schemas/supported-types" },
            { label: "Rejected Shapes", slug: "schemas/rejected-shapes" },
            {
              label: "Date, BigInt, Map, Set",
              slug: "schemas/rich-types",
            },
          ],
        },
        {
          label: "Versioning",
          items: [
            { label: "Wire Fingerprints", slug: "versioning/fingerprinting" },
            {
              label: "Schema Changes",
              slug: "versioning/schema-evolution",
            },
          ],
        },
        {
          label: "Wire Format",
          items: [
            { label: "Byte Layout", slug: "wire-format/layout" },
            { label: "Low-Level m API", slug: "wire-format/low-level-api" },
          ],
        },
        {
          label: "Comparisons",
          items: [
            { label: "shorn vs JSON", slug: "comparisons/json" },
            {
              label: "vs Avro, Protobuf, SchemaPack",
              slug: "comparisons/schema-codecs",
            },
            {
              label: "vs MessagePack, CBOR",
              slug: "comparisons/schemaless-codecs",
            },
          ],
        },
        {
          label: "Performance",
          items: [
            { label: "Payload Size", slug: "performance/size" },
            { label: "Throughput", slug: "performance/throughput" },
            { label: "Footprint", slug: "performance/footprint" },
          ],
        },
        {
          label: "Hostile Input",
          slug: "hostile-input",
        },
        {
          label: "API",
          items: [
            { label: "API Overview", slug: "api/overview" },
            { label: "Functions", slug: "api/functions" },
            { label: "m Builders", slug: "api/m" },
            { label: "Errors", slug: "api/errors" },
          ],
        },
        {
          label: "LLM Docs",
          link: "/llms-full.txt",
          attrs: {
            target: "_blank",
            rel: "noopener noreferrer",
          },
        },
      ],
    }),
  ],
});
