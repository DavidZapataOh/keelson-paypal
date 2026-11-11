import { component, defineMarkdocConfig, nodes } from "@astrojs/markdoc/config";

// The fence keeps the built-in attributes but renders `content` and `language` as props.
// Spreading `nodes.fence` would also carry its transform, which hands the code over as a slot.
export default defineMarkdocConfig({
  nodes: {
    // Pages render inside our own <article>; Markdoc's would nest a second one.
    document: { ...nodes.document, render: null },
    fence: {
      attributes: {
        ...nodes.fence.attributes,
        content: { type: String, render: "content" },
        language: { type: String, render: "language" },
        file: { type: String },
        check: { type: String },
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
  },
});
