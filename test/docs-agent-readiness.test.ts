import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_GUIDANCE,
  AGENT_RESOURCES,
  DESCRIPTION,
  PACKAGE,
  SITE,
  structuredData,
} from "../docs/src/lib/agent-metadata.js";

// The docs site tells a machine reader three things a human reader gets from the prose:
// what shorn is (JSON-LD), when to reach for it (llms.txt), and where to look after a
// wrong guess (the 404 page). None of them fail loudly when they go stale: a dead link
// on the 404 page is a 404 reached from a 404, so each gets a check here.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("robots.txt", () => {
  const robots = read("docs/public/robots.txt");

  it("allows every crawler and points at the sitemap Astro actually emits", () => {
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).toMatch(/^Allow: \/$/m);
    // astro.config.mjs sets `site`, so Astro emits sitemap-index.xml, not sitemap.xml.
    expect(robots).toMatch(/^Sitemap: https:\/\/shorn\.dev\/sitemap-index\.xml$/m);
  });
});

describe("agent guidance in llms.txt", () => {
  it("says when to use shorn, and when not to", () => {
    expect(AGENT_GUIDANCE).toContain("## When to use shorn");
    expect(AGENT_GUIDANCE).toContain("Reach for shorn when:");
    expect(AGENT_GUIDANCE).toContain("Reach for something else when:");
  });

  it("names the install command with the published package name", () => {
    const name = JSON.parse(read("package.json")).name as string;
    // A rename is the way this sentence goes wrong: the guidance would keep telling
    // agents to install a package that no longer exists.
    expect(PACKAGE).toBe(name);
    expect(AGENT_GUIDANCE).toContain(`npm install ${name}`);
  });

  it("says there is no API to call, which is why no OpenAPI document exists", () => {
    expect(AGENT_GUIDANCE).toContain("not a service you call");
    expect(AGENT_GUIDANCE).toMatch(/no API key/);
  });
});

describe("recovery links on the 404 page", () => {
  it("links only to docs pages that exist in the content collection", () => {
    const pages = AGENT_RESOURCES.map((r) => r.href).filter(
      (href) => !href.startsWith("http") && !/\.(txt|xml)$/.test(href),
    );
    expect(pages.length).toBeGreaterThan(0);
    for (const href of pages) {
      const slug = href.replace(/^\/|\/$/g, "");
      // Throws if the page behind the link is gone, which is the failure worth catching.
      expect(read(`docs/src/content/docs/${slug}.md`).length).toBeGreaterThan(0);
    }
  });

  it("gives every link a label and a reason to follow it", () => {
    for (const resource of AGENT_RESOURCES) {
      expect(resource.label).not.toBe("");
      expect(resource.note).not.toBe("");
    }
  });
});

describe("landing page JSON-LD", () => {
  const graph = structuredData() as { "@context": string; "@graph": Record<string, unknown>[] };

  it("is a schema.org graph naming the software, the site, and the author", () => {
    expect(graph["@context"]).toBe("https://schema.org");
    const types = graph["@graph"].map((node) => node["@type"]);
    expect(types).toEqual(["SoftwareApplication", "WebSite", "Person"]);
  });

  it("survives serialisation, which is how it reaches the page", () => {
    expect(JSON.parse(JSON.stringify(graph))).toEqual(graph);
  });

  it("describes the software with the fields a reader looks for first", () => {
    const app = graph["@graph"][0] as Record<string, unknown>;
    expect(app["name"]).toBe("shorn");
    expect(app["description"]).toBe(DESCRIPTION);
    expect(app["url"]).toBe(`${SITE}/`);
    expect(app["offers"]).toMatchObject({ price: "0" });
    expect(app["downloadUrl"]).toContain(PACKAGE);
  });

  it("resolves every internal @id reference within the graph", () => {
    const ids = new Set(graph["@graph"].map((node) => node["@id"]));
    const refs = JSON.stringify(graph).match(/"@id":"[^"]+"/g) ?? [];
    for (const ref of refs) {
      expect(ids).toContain(JSON.parse(`{${ref}}`)["@id"]);
    }
  });

  it("keeps absolute URLs on the origin it was given", () => {
    const other = structuredData("https://example.test") as { "@graph": Record<string, unknown>[] };
    expect((other["@graph"][0] as Record<string, unknown>)["url"]).toBe("https://example.test/");
    // Trailing slashes on the way in must not double up on the way out.
    const trailing = structuredData("https://example.test/") as {
      "@graph": Record<string, unknown>[];
    };
    expect(trailing["@graph"][0]!["url"]).toBe("https://example.test/");
  });
});

// The three pages a reader (human or agent) opens to decide whether a package is a real
// project before depending on it. Every way they go wrong is quiet: a page emptied to its
// heading still builds, an invented support address still renders, and the privacy page
// keeps making claims about the code long after the code stops backing them.
const TRUST_PAGES = ["about", "contact", "privacy"] as const;

/** What a visitor actually reads: frontmatter, markup, and expressions removed. */
const prose = (source: string) =>
  source
    .replace(/^---[\s\S]*?\n---/, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\{[^{}]*\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("trust anchor pages", () => {
  const pages = TRUST_PAGES.map((slug) => ({
    slug,
    source: read(`docs/src/pages/${slug}.astro`),
  }));

  it.each(pages)("$slug renders enough prose to be worth reading", ({ source }) => {
    // 500 characters is the audit's floor for "this page says something". A stub that
    // only sets a title would sail through a build and fail the audit silently.
    expect(prose(source).length).toBeGreaterThan(500);
  });

  it.each(pages)("$slug inherits the Starlight shell", ({ source }) => {
    // Without StarlightPage the page renders unstyled and outside the docs navigation,
    // which reads as a broken or abandoned site.
    expect(source).toContain("@astrojs/starlight/components/StarlightPage.astro");
    expect(source).toMatch(/<StarlightPage/);
  });

  it.each(pages)("$slug invents no contact detail", ({ source }) => {
    // GitHub issues is the only channel that exists. An email address, a phone number, or
    // a leftover placeholder here is a promise nobody can keep.
    expect(source).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    expect(source).not.toMatch(/\+?\d[\d ()-]{7,}\d/);
    expect(source).not.toMatch(/\b(TODO|TBD|FIXME|lorem ipsum|placeholder|example\.com)\b/i);
  });

  it("is reachable from the landing page footer", () => {
    const landing = read("docs/src/layouts/Landing.astro");
    for (const { slug } of pages) {
      // Via the p() helper, so the links survive the configured `base`.
      expect(landing).toContain(`p("${slug}/")`);
    }
  });
});

describe("the privacy page's claims about the code", () => {
  const dir = new URL("../docs/src/", import.meta.url);
  const sources = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((rel) => /\.(astro|ts|css)$/.test(rel))
    .map((rel) => ({ rel, text: readFileSync(new URL(rel, dir), "utf8") }));

  it("finds no third-party script, font, or analytics service in the site", () => {
    expect(sources.length).toBeGreaterThan(0);
    const thirdParty =
      /googletagmanager|google-analytics|fonts\.googleapis|plausible\.io|posthog|sentry\.io|umami|usefathom|hotjar|clarity\.ms|mixpanel|cdn\.jsdelivr|unpkg\.com|cloudflareinsights/i;
    for (const { rel, text } of sources) {
      expect(text, `third-party host in ${rel}`).not.toMatch(thirdParty);
      // A remote `src` is the other way one arrives, under a host not on that list.
      expect(text, `external script tag in ${rel}`).not.toMatch(/<script[^>]+src=/i);
    }
    const docsPkg = JSON.parse(read("docs/package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.keys({ ...docsPkg.dependencies, ...docsPkg.devDependencies });
    expect(deps.filter((name) => /analytics|posthog|sentry|plausible|umami|fathom/i.test(name))).toEqual(
      [],
    );
  });

  it("sets no cookie, and keeps browser storage to the one theme write", () => {
    const writes = sources.flatMap(({ rel, text }) =>
      [...text.matchAll(/(?:local|session)Storage\.setItem\(\s*["']([^"']+)["']/g)].map((m) => ({
        rel,
        key: m[1],
      })),
    );
    // The page names exactly one value this site writes, plus Starlight's own sidebar key.
    // A second write here, or a cookie, makes that paragraph false.
    expect(writes).toEqual([{ rel: "components/Head.astro", key: "starlight-theme" }]);
    for (const { rel, text } of sources) {
      expect(text, `cookie written in ${rel}`).not.toMatch(/document\.cookie\s*=/);
    }
  });

  it("keeps the playground, and the site, from sending anything anywhere", () => {
    // "What you type is never transmitted" holds only while nothing in the site can talk
    // to a server. The playground's own imports are bundled, so they are not requests.
    for (const { rel, text } of sources) {
      expect(text, `network call in ${rel}`).not.toMatch(
        /\bfetch\(|XMLHttpRequest|sendBeacon|navigator\.connection/,
      );
    }
  });

  it("keeps the published library free of network calls", () => {
    for (const rel of readdirSync(new URL("../src/", import.meta.url))) {
      expect(read(`src/${rel}`), `network call in src/${rel}`).not.toMatch(
        /\bfetch\(|XMLHttpRequest|from "node:(http|https|net|tls|dgram)"/,
      );
    }
  });
});
