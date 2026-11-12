import { component, defineMarkdocConfig, Markdoc, nodes } from "@astrojs/markdoc/config";

const LANGUAGES = { ts: "TypeScript", python: "Python", sh: "Shell" };

// The fence keeps the built-in attributes but renders `content` and `language` as props.
// Spreading `nodes.fence` would also carry its transform, which hands the code over as a slot.
export default defineMarkdocConfig({
  nodes: {
    // Pages render inside our own <article>; Markdoc's would nest a second one.
    document: { ...nodes.document, render: null },
    table: { render: component("./src/components/Table.astro") },
    fence: {
      attributes: {
        ...nodes.fence.attributes,
        content: { type: String, render: "content" },
        language: { type: String, render: "language" },
        file: { type: String },
        check: { type: String },
        title: { type: String },
      },
      render: component("./src/components/Fence.astro"),
    },
  },
  tags: {
    callout: {
      render: component("./src/components/Callout.astro"),
      attributes: {
        type: { type: String, default: "note", matches: ["note", "caution"] },
        title: { type: String },
      },
    },
    walkthrough: { render: component("./src/components/Walkthrough.astro") },
    steps: { render: component("./src/components/Steps.astro") },
    step: {
      render: component("./src/components/Step.astro"),
      attributes: {
        title: { type: String, required: true },
        file: { type: String, required: true },
        lines: { type: String, matches: /^\d+(-\d+)?$/ },
      },
    },
    files: { render: component("./src/components/Files.astro") },
    // The same example in each language, as tabs: `label` names the tab list and must be unique on the page.
    languages: {
      render: component("./src/components/CodeTabs.astro"),
      attributes: { label: { type: String, required: true } },
      transform(node, config) {
        const items = node.children
          .filter((child) => child.type === "fence")
          .map((fence) => ({
            name: fence.attributes.title ?? LANGUAGES[fence.attributes.language] ?? fence.attributes.language,
            lang: fence.attributes.language,
            code: fence.attributes.content.replace(/\n$/, ""),
          }));
        return new Markdoc.Tag(this.render, { ...node.transformAttributes(config), items }, []);
      },
    },
  },
});
