import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection, type CollectionEntry } from "astro:content";

// A markdown twin of every docs page, at the page's own path plus `.md`. This is the
// half of the llms.txt v2 convention that a single llms.txt does not cover: agents
// arriving from a search result or the README guess a `.md` URL rather than reading
// the map first, and a 404 there sends them back to parsing HTML.
export const getStaticPaths: GetStaticPaths = async () => {
  const docs = await getCollection("docs");
  return docs.map((entry) => ({ params: { slug: entry.id }, props: { entry } }));
};

export const GET: APIRoute = ({ props }) => {
  const { entry } = props as { entry: CollectionEntry<"docs"> };

  // Starlight renders the H1 and the description from frontmatter, so `body` has
  // neither. Put them back, or the file opens on a heading from the middle of the page.
  const front = [`# ${entry.data.title}`, entry.data.description && `> ${entry.data.description}`]
    .filter(Boolean)
    .join("\n\n");

  return new Response(`${front}\n\n${entry.body ?? ""}`, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
};
