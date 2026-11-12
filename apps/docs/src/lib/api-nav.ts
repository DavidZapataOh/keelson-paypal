import type { NavSection } from "./docs";
import { operations, tagName } from "./openapi";

/** The API reference's side navigation: operations grouped by tag. */
export function apiNav(): NavSection[] {
  const groups = new Map<string, NavSection["items"]>();
  for (const op of operations()) {
    const items = groups.get(op.tag) ?? [];
    items.push({ title: op.summary, href: `/reference/api/${op.slug}/` });
    groups.set(op.tag, items);
  }
  return [...groups].map(([tag, items]) => ({
    section: tagName(tag) as NavSection["section"],
    items,
  }));
}
