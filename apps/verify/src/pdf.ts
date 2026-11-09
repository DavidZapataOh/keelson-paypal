import { extractAlibi } from "@keelson/alibi/extract";
import { GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

/** The embedded `.alibi` of a PDF, parsed by pdf.js in its worker. */
export const extractPdf = (pdf: Uint8Array): Promise<Uint8Array> => extractAlibi(pdf);
