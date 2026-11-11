import Lithic from "lithic";

/** The issuer-side controls of a single-use card, set when it is issued. */
export interface CardControls {
  /** The most one authorization may hold, in minor units: the countersigned amount. */
  spendLimitMinor: bigint;
  /** ISO 18245 merchant category codes the card may be used at. */
  mcc: readonly string[];
  /** ISO 3166-1 alpha-2 countries the card may be used in. */
  countries: readonly string[];
  /** A label on the card, for the issuer's dashboard: the purchase id. */
  memo: string;
}

export interface IssuedCard {
  token: string;
  lastFour: string;
}

/** What Keelson needs from a card issuer. The card number never passes through it. */
export interface CardIssuer {
  readonly name: "lithic";
  /** Issues a paused single-use virtual card bound by `controls`. */
  issue(controls: CardControls): Promise<IssuedCard>;
  /** Lets the card be authorized. */
  open(token: string): Promise<void>;
  /** Closes the card for good. */
  close(token: string): Promise<void>;
  /**
   * A short-lived URL of the issuer's hosted page showing the card's number, expiry and code,
   * for the agent's browser: the details go from the issuer to that browser only.
   */
  embedUrl(token: string, ttlSeconds: number): string;
  /** Parses a request the issuer signed with `secret`; throws when the signature does not verify. */
  verify(body: string, headers: Headers, secret: string): unknown;
}

/** ISO 3166-1 alpha-2 to alpha-3, for the countries a card merchant may name. */
const ALPHA3: Readonly<Record<string, string>> = {
  US: "USA",
  CA: "CAN",
  MX: "MEX",
  GB: "GBR",
  IE: "IRL",
  FR: "FRA",
  DE: "DEU",
  ES: "ESP",
  IT: "ITA",
  NL: "NLD",
  BE: "BEL",
  PT: "PRT",
  CH: "CHE",
  AT: "AUT",
  SE: "SWE",
  NO: "NOR",
  DK: "DNK",
  FI: "FIN",
  PL: "POL",
  AU: "AUS",
  NZ: "NZL",
  JP: "JPN",
  KR: "KOR",
  SG: "SGP",
  HK: "HKG",
  IN: "IND",
  BR: "BRA",
  AR: "ARG",
  CL: "CHL",
  CO: "COL",
  PE: "PER",
};

/** The alpha-2 code of an ISO 3166-1 alpha-3 country, or `undefined` for one not listed. */
export function alpha2(alpha3: string): string | undefined {
  return Object.entries(ALPHA3).find(([, a3]) => a3 === alpha3)?.[0];
}

/** Lithic, through its official SDK (sandbox unless `environment` is `production`). */
export class LithicIssuer implements CardIssuer {
  readonly name = "lithic";
  private readonly client: Lithic;

  constructor(apiKey: string, environment: "sandbox" | "production" = "sandbox") {
    this.client = new Lithic({ apiKey, environment, timeout: 5_000, maxRetries: 1 });
  }

  async issue(c: CardControls): Promise<IssuedCard> {
    const countries = c.countries.map((x) => {
      const a3 = ALPHA3[x];
      if (!a3) throw new RangeError(`country ${x} has no issuer code`);
      return a3;
    });
    const card = await this.client.cards.create({
      type: "SINGLE_USE",
      state: "PAUSED",
      spend_limit: Number(c.spendLimitMinor),
      spend_limit_duration: "TRANSACTION",
      memo: c.memo,
    });
    // Each rule declines on its own, so a card is declined outside either list.
    await Promise.all(
      (
        [
          ["MCC", [...c.mcc]],
          ["COUNTRY", countries],
        ] as const
      ).map(([attribute, value]) =>
        this.client.authRules.v2.create({
          card_tokens: [card.token],
          type: "CONDITIONAL_ACTION",
          event_stream: "AUTHORIZATION",
          name: `${c.memo} ${attribute}`,
          parameters: {
            action: "DECLINE",
            conditions: [{ attribute, operation: "IS_NOT_ONE_OF", value: [...value] }],
          },
        }),
      ),
    );
    return { token: card.token, lastFour: card.last_four };
  }

  async open(token: string): Promise<void> {
    await this.client.cards.update(token, { state: "OPEN" });
  }

  async close(token: string): Promise<void> {
    await this.client.cards.update(token, { state: "CLOSED" });
  }

  verify(body: string, headers: Headers, secret: string): unknown {
    return this.client.webhooks.unwrap(body, headers, secret);
  }

  embedUrl(token: string, ttlSeconds: number): string {
    return this.client.cards.getEmbedURL({
      token,
      expiration: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    });
  }
}
