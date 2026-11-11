import { type CollectionEntry, getCollection } from "astro:content";
import { SECTIONS } from "../content.config";

export const SITE = "https://docs.keelson.finance";

export type Doc = CollectionEntry<"docs">;

/** Every page, ordered by section, then by `order`. */
export async function docs(): Promise<Doc[]> {
  const all = await getCollection("docs");
  return all.sort(
    (a, b) =>
      SECTIONS.indexOf(a.data.section) - SECTIONS.indexOf(b.data.section) ||
      a.data.order - b.data.order,
  );
}

/** The page's path on the site, with the trailing slash the site uses. */
export const href = (id: string) => (id === "index" ? "/" : `/${id}/`);

export interface NavSection {
  section: (typeof SECTIONS)[number];
  items: { title: string; href: string }[];
}

export async function nav(): Promise<NavSection[]> {
  const all = (await docs()).filter((d) => d.id !== "index");
  return SECTIONS.map((section) => ({
    section,
    items: [
      ...all
        .filter((d) => d.data.section === section)
        .map((d) => ({ title: d.data.title, href: href(d.id) })),
      ...(section === "Reference" ? [{ title: "API reference", href: "/reference/api/" }] : []),
    ],
  })).filter((s) => s.items.length > 0);
}
