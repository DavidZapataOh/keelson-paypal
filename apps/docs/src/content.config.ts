import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

export const SECTIONS = ["Start", "Concepts", "Security", "Reference"] as const;

export const collections = {
  docs: defineCollection({
    loader: glob({ pattern: ["**/*.mdoc", "!**/_*/**"], base: "./src/content/docs" }),
    schema: z.object({
      title: z.string(),
      description: z.string(),
      estimate: z.string().optional(),
      section: z.enum(SECTIONS),
      order: z.number(),
    }),
  }),
};
