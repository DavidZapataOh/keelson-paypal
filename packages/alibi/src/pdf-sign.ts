import { createHash } from "node:crypto";
import { requestTimestamp, type TsaId } from "@keelson/timestamp";
import { plainAddPlaceholder } from "@signpdf/placeholder-plain";
import { SignPdf } from "@signpdf/signpdf";
import { Signer, SUBFILTER_ETSI_CADES_DETACHED } from "@signpdf/utils";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

const ID_DATA = "1.2.840.113549.1.7.1";
const ID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const ID_CONTENT_TYPE = "1.2.840.113549.1.9.3";
const ID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
/** RFC 5035 `id-aa-signingCertificateV2`. */
const ID_SIGNING_CERTIFICATE_V2 = "1.2.840.113549.1.9.16.2.47";
/** RFC 3161 Appendix A `id-aa-signatureTimeStampToken`. */
const ID_SIGNATURE_TIMESTAMP = "1.2.840.113549.1.9.16.2.14";

/** The key that signs Alibi PDFs and its certificate chain, leaf first. */
export interface PdfSigner {
  key: CryptoKey;
  chain: pkijs.Certificate[];
}

const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());

function pemBlocks(pem: string, label: string): Uint8Array<ArrayBuffer>[] {
  const re = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`, "g");
  return [...pem.matchAll(re)].map((m) => new Uint8Array(Buffer.from(m[1] as string, "base64")));
}

/** A signer from a P-256 PKCS #8 key and its PEM certificate chain, leaf first. */
export async function localPdfSigner(pkcs8Pem: string, chainPem: string): Promise<PdfSigner> {
  const [der] = pemBlocks(pkcs8Pem, "PRIVATE KEY");
  if (!der) throw new Error("no PKCS #8 private key");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const chain = pemBlocks(chainPem, "CERTIFICATE").map((c) => pkijs.Certificate.fromBER(c));
  if (chain.length === 0) throw new Error("no certificate");
  return { key, chain };
}

/**
 * A CAdES detached signature (ETSI EN 319 122-1 baseline B-T) over the bytes signpdf hands it:
 * the content type, message digest and signing certificate are signed; the signing time is not
 * (PAdES puts it in the signature dictionary). Its signature value is timestamped by `tsa`.
 */
class CadesSigner extends Signer {
  constructor(
    private readonly signer: PdfSigner,
    private readonly tsa: TsaId,
  ) {
    super();
  }

  override async sign(data: Buffer): Promise<Buffer> {
    const [leaf] = this.signer.chain as [pkijs.Certificate];
    const essCertIdV2 = new asn1js.Sequence({
      value: [
        new asn1js.Sequence({
          value: [
            new asn1js.Sequence({
              value: [
                new asn1js.OctetString({
                  valueHex: sha256(new Uint8Array(leaf.toSchema().toBER())),
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const info = new pkijs.SignerInfo({
      version: 1,
      sid: new pkijs.IssuerAndSerialNumber({
        issuer: leaf.issuer,
        serialNumber: leaf.serialNumber,
      }),
      signedAttrs: new pkijs.SignedAndUnsignedAttributes({
        type: 0,
        attributes: [
          new pkijs.Attribute({
            type: ID_CONTENT_TYPE,
            values: [new asn1js.ObjectIdentifier({ value: ID_DATA })],
          }),
          new pkijs.Attribute({
            type: ID_MESSAGE_DIGEST,
            values: [new asn1js.OctetString({ valueHex: sha256(data) })],
          }),
          new pkijs.Attribute({ type: ID_SIGNING_CERTIFICATE_V2, values: [essCertIdV2] }),
        ],
      }),
    });
    const signed = new pkijs.SignedData({
      version: 1,
      encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: ID_DATA }),
      signerInfos: [info],
      certificates: this.signer.chain,
    });
    await signed.sign(this.signer.key, 0, "SHA-256");
    const value = new Uint8Array(info.signature.valueBlock.valueHexView);
    const stamp = await requestTimestamp(this.tsa, sha256(value), { timeoutMs: 5_000 });
    info.unsignedAttrs = new pkijs.SignedAndUnsignedAttributes({
      type: 1,
      attributes: [
        new pkijs.Attribute({
          type: ID_SIGNATURE_TIMESTAMP,
          values: [asn1js.fromBER(stamp.token).result],
        }),
      ],
    });
    const cms = new pkijs.ContentInfo({
      contentType: ID_SIGNED_DATA,
      content: signed.toSchema(true),
    });
    return Buffer.from(cms.toSchema().toBER());
  }
}

/**
 * Carries the rendered file's `/ID` into the update's trailer, which the placeholder writes
 * without one: PDF/A requires it in every trailer (ISO 19005-3 §6.1.3). The trailer follows the
 * update's cross-reference section, so no offset moves.
 */
function withFileId(rendered: Uint8Array, placed: Buffer): Buffer {
  const id = /\/ID\s*(\[[^\]]*\])/.exec(Buffer.from(rendered).toString("latin1"))?.[1];
  if (!id) throw new Error("the rendered PDF has no file identifier");
  const text = placed.toString("latin1");
  const at = text.lastIndexOf("trailer");
  const open = text.indexOf("<<", at) + 2;
  return Buffer.concat([
    placed.subarray(0, open),
    Buffer.from(`\n/ID ${id}`),
    placed.subarray(open),
  ]);
}

/**
 * Signs a rendered Alibi PDF with PAdES baseline B-T (ETSI EN 319 142-1): an incremental update
 * adds a `/ETSI.CAdES.detached` signature over the whole file as rendered, whose signature value
 * an RFC 3161 TSA timestamps. The embedded `.alibi` and the PDF/A-3 rendering are untouched.
 */
export async function signAlibiPdf(
  pdf: Uint8Array,
  signer: PdfSigner,
  o: { tsa: TsaId; now?: Date },
): Promise<Uint8Array> {
  const placed = plainAddPlaceholder({
    pdfBuffer: Buffer.from(pdf),
    reason: "Keelson Alibi: what an agent was allowed to buy and what it bought",
    contactInfo: "https://keelson.finance",
    name: "Keelson",
    location: "https://verify.keelson.finance",
    signingTime: o.now ?? new Date(),
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
    signatureLength: 16_384,
  });
  return new Uint8Array(
    await new SignPdf().sign(withFileId(pdf, placed), new CadesSigner(signer, o.tsa)),
  );
}
