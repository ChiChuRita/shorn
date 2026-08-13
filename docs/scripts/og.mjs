// Renders docs/public/og.png, the social card. Run `node scripts/og.mjs` from
// docs/ after changing the headline or the byte counts it quotes.
//
// Not part of the build: the card changes about once a year, and a build step that
// rasterises a PNG on every CI run to produce the same bytes is a step to maintain.
import { writeFileSync } from "node:fs";
import sharp from "sharp";

const BG = "#0a0a0a";
const INK = "#ededed";
const INK_2 = "#a1a1a1";
const INK_3 = "#7a7a7a";
const MARK_DIM = "#606060";
const SANS = "Helvetica Neue, Helvetica, Arial, sans-serif";

// The same comparison the landing figure makes, at the two ends that matter.
const rows = [
  { label: "shorn", bytes: 8, self: true },
  { label: "JSON", bytes: 35, self: false },
];

const cells = (row, y) =>
  Array.from(
    { length: row.bytes },
    (_, i) =>
      `<rect x="${232 + i * 17}" y="${y}" width="13" height="26" rx="3" fill="${
        row.self ? INK : MARK_DIM
      }"/>`,
  ).join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <rect width="1200" height="630" fill="${BG}"/>

  <g transform="translate(80,74)" fill="${INK}">
    <rect x="2" y="2" width="25" height="6.5" rx="2" fill="none" stroke="${INK}" stroke-width="2"/>
    <rect x="2" y="13.5" width="9" height="6.5" rx="2"/>
    <text x="40" y="19" font-family="${SANS}" font-size="25" font-weight="500">shorn</text>
  </g>

  <text font-family="${SANS}" font-size="62" font-weight="500" fill="${INK}" letter-spacing="-2">
    <tspan x="80" y="248">Your validator is</tspan>
    <tspan x="80" y="318">the wire format.</tspan>
  </text>

  <text x="80" y="382" font-family="${SANS}" font-size="26" fill="${INK_2}">
    Compact, canonical bytes from Zod, Valibot, or ArkType.
  </text>

  ${rows
    .map((row, i) => {
      const y = 470 + i * 46;
      return `<text x="80" y="${y + 20}" font-family="${SANS}" font-size="20" fill="${
        row.self ? INK : INK_3
      }">${row.label}</text>${cells(row, y)}<text x="${
        232 + row.bytes * 17 + 14
      }" y="${y + 20}" font-family="${SANS}" font-size="20" fill="${
        row.self ? INK : INK_3
      }">${row.bytes} bytes</text>`;
    })
    .join("\n  ")}

  <text x="80" y="590" font-family="${SANS}" font-size="20" fill="${INK_3}">
    npm install @chichurita/shorn
  </text>
</svg>`;

const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
writeFileSync(new URL("../public/og.png", import.meta.url), png);
console.log(`og.png ${png.length} bytes`);
