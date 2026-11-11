/** A purchase's SCITT Transparent Statement, as an export carries it. */
export interface AlibiRef {
  /** The Transparent Statement, base64url. */
  statement: string;
  /** SHA-256(0x00 ‖ registered statement), base64url. */
  leafHash: string;
  /** Where the statement is served, `application/scitt-statement+cose`. */
  uri: string;
}
