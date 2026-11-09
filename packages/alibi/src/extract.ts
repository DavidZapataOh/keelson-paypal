import { getDocument } from "pdfjs-dist";
import { AlibiFormatError, decodeAlibi } from "./codec.ts";

/**
 * The bytes of the one `.alibi` file embedded in a PDF, which must decode as an Alibi bundle.
 *
 * @throws {AlibiFormatError} `attachment` when the PDF embeds no such file, or more than one.
 */
export async function extractAlibi(pdf: Uint8Array): Promise<Uint8Array> {
  const task = getDocument({ data: pdf.slice(), stopAtErrors: true });
  const doc = await task.promise;
  try {
    const attachments = (await doc.getAttachments()) ?? new Map();
    const ids = [...attachments.entries()]
      .filter(([, a]) => a.filename.endsWith(".alibi"))
      .map(([id]) => id);
    if (ids.length !== 1) {
      throw new AlibiFormatError("attachment", `the PDF embeds ${ids.length} alibi files`);
    }
    const bytes = await doc.getAttachmentContent(ids[0] as string);
    if (!bytes) throw new AlibiFormatError("attachment", "the embedded alibi is empty");
    decodeAlibi(bytes);
    return bytes;
  } finally {
    await task.destroy();
  }
}
