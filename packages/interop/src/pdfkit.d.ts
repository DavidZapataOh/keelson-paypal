declare namespace PDFKit.Mixins {
  interface PDFAttachmentOptions {
    /** The file's `AFRelationship` (PDF 2.0, PDF/A-3). */
    relationship?: "Alternative" | "Data" | "Source" | "Supplement" | "Unspecified";
  }
}

declare module "pdfkit/output" {
  /** Collects the document's output; call before `doc.end()`. */
  export function toBytes(doc: PDFKit.PDFDocument): Promise<Uint8Array>;
}
