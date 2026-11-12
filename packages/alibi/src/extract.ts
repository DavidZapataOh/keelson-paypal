import { getDocument } from "pdfjs-dist";
import { AlibiFormatError, decodeAny, statementOf, versionOf } from "./codec.ts";
import type { AlibiBundleV2 } from "./schema.ts";

/**
 * The bytes of the one `.alibi` file embedded in a PDF, which must decode as an Alibi bundle. A v2
 * Alibi's PDF also embeds its transparent statement, which must be the bundle's.
 *
 * @throws {AlibiFormatError} `attachment` when the PDF embeds no such file, or more than one, or
 * a statement that is not the bundle's.
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
    const alibi = decodeAny(bytes);
    if (versionOf(alibi) === 2) {
      const cose = [...attachments.entries()].filter(([, a]) => a.filename.endsWith(".cose"));
      const embedded =
        cose.length === 1 ? await doc.getAttachmentContent(cose[0]?.[0] as string) : null;
      const statement = statementOf(alibi as AlibiBundleV2);
      if (
        !embedded ||
        embedded.length !== statement.length ||
        !embedded.every((x, i) => x === statement[i])
      ) {
        throw new AlibiFormatError("attachment", "the embedded statement is not the Alibi's");
      }
    }
    return bytes;
  } finally {
    await task.destroy();
  }
}
