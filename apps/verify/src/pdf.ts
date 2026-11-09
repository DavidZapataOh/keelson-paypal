import { extractAlibi } from "@keelson/alibi/extract";
import { GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

/** The embedded `.alibi` of a PDF, parsed by pdf.js in its worker; a PDF that stalls it is refused. */
export const extractPdf = (pdf: Uint8Array): Promise<Uint8Array> =>
  Promise.race([
    extractAlibi(pdf),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("reading the PDF took longer than 20 s")), 20_000),
    ),
  ]);
