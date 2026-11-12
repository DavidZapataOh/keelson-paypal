import type { APIRoute, GetStaticPaths } from "astro";
import { docs } from "../lib/docs";

export const getStaticPaths = (async () =>
  (await docs()).map((entry) => ({
    params: { slug: entry.id },
    props: { body: `${(entry.body ?? "").trimEnd()}\n` },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) =>
  new Response(props.body as string, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
