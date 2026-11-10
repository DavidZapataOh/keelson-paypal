import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { Amount } from "../src/components/amount.tsx";
import { BlockDiff } from "../src/components/block-diff.tsx";
import { CopyValue } from "../src/components/copy-value.tsx";
import { DataItem, DataList } from "../src/components/data-list.tsx";
import { LiabilityField } from "../src/components/liability.tsx";
import { Meter } from "../src/components/meter.tsx";
import { Timeline, TimelineItem } from "../src/components/timeline.tsx";

const html = (node: React.ReactNode) => renderToStaticMarkup(node);

describe("Amount", () => {
  test("mono, tabular, currency code muted", () => {
    const out = html(<Amount value={340} />);
    expect(out).toContain("$340.00");
    expect(out).toContain("font-mono");
    expect(out).toContain("tabular-nums");
    expect(out).toMatch(/text-muted-foreground[^>]*>USD</);
  });

  test("explicit sign when asked, a true minus for negatives", () => {
    expect(html(<Amount value={12.5} signed />)).toContain("+$12.50");
    expect(html(<Amount value={-95} />)).toContain("−$95.00");
  });

  test("a struck amount says why to assistive technology", () => {
    const out = html(<Amount value={340} struck="Blocked" />);
    expect(out).toContain("<s");
    expect(out).toContain("Blocked");
    expect(out).toContain("sr-only");
  });

  test("other currencies", () => {
    expect(html(<Amount value={1000} currency="EUR" />)).toContain("€1,000.00");
  });
});

describe("DataList", () => {
  test("a description list of label and value", () => {
    const out = html(
      <DataList>
        <DataItem label="Merchant">Nike</DataItem>
      </DataList>,
    );
    expect(out).toMatch(/^<dl[^>]*data-layout="row"/);
    expect(out).toContain("<dt");
    expect(out).toContain(">Merchant<");
    expect(out).toContain("<dd");
  });

  test("stacked layout for detail rails", () => {
    expect(html(<DataList layout="stacked" />)).toContain('data-layout="stacked"');
  });
});

describe("CopyValue", () => {
  test("mono value with a named copy button", () => {
    const out = html(<CopyValue value="01M6W3TTKRC43V70XQAT1QQK6V" label="Alibi ID" />);
    expect(out).toContain("font-mono");
    expect(out).toContain("01M6W3TTKRC43V70XQAT1QQK6V");
    expect(out).toMatch(/<button[^>]*aria-label="Copy Alibi ID"/);
  });

  test("long values can be shortened on screen, never in the copy", () => {
    const out = html(<CopyValue value="84712997ee424ff5a1b2c3d4e5f60718" label="Leaf" short />);
    expect(out).toContain("847129…0718");
    expect(out).toContain('title="84712997ee424ff5a1b2c3d4e5f60718"');
  });
});

describe("Timeline", () => {
  test("an ordered list of who did what and when", () => {
    const out = html(
      <Timeline>
        <TimelineItem state="done" actor="You" time="2026-11-09T14:02:07Z">
          signed the mandate
        </TimelineItem>
        <TimelineItem state="blocked" actor="Keelson" time="2026-11-09T14:02:09Z">
          blocked the cart: $340.00 over the $100.00 cap
        </TimelineItem>
        <TimelineItem state="upcoming" actor="PayPal">
          decides the dispute
        </TimelineItem>
      </Timeline>,
    );
    expect(out).toMatch(/^<ol/);
    expect(out).toContain('dateTime="2026-11-09T14:02:07Z"');
    expect(out).toContain(">Keelson<");
    expect(out).toContain('data-state="blocked"');
  });

  test("vermilion fills only Keelson's block; a failure is an ink '!'", () => {
    const blocked = html(<TimelineItem state="blocked" actor="Keelson" />);
    const failed = html(<TimelineItem state="failed" actor="PayPal" />);
    expect(blocked).toContain("bg-vermilion");
    expect(failed).not.toContain("bg-vermilion");
    expect(failed).toContain(">!<");
    for (const s of ["done", "current", "upcoming"] as const) {
      expect(html(<TimelineItem state={s} actor="You" />)).not.toContain("vermilion");
    }
  });

  test("the current step is announced", () => {
    expect(html(<TimelineItem state="current" actor="Keelson" />)).toContain('aria-current="step"');
  });
});

describe("Meter", () => {
  test("a meter with its values in words", () => {
    const out = html(<Meter label="Mandate used" value={40} max={100} format={(n) => `$${n}`} />);
    expect(out).toContain('role="meter"');
    expect(out).toContain('aria-valuenow="40"');
    expect(out).toContain('aria-valuemax="100"');
    expect(out).toContain('aria-valuetext="$40 of $100"');
    expect(out).toContain("$40 of $100");
  });

  test("past 90% it turns warn and says so, never vermilion", () => {
    const out = html(<Meter label="Mandate used" value={95} max={100} />);
    expect(out).toContain("bg-warn");
    expect(out).toContain("Near the cap");
    expect(out).not.toContain("vermilion");
  });
});

describe("BlockDiff", () => {
  test("one line: the mandate, the cart, the block", () => {
    const out = html(<BlockDiff field="Total" mandate="max $100.00" cart="$340.00" />);
    expect(out).toContain("Mandate");
    expect(out).toContain("max $100.00");
    expect(out).toContain("Cart");
    expect(out).toContain("$340.00");
    expect(out).toContain(">Blocked<");
    expect(out).toContain("font-mono");
  });
});

describe("LiabilityField", () => {
  test("the field, its value and who answers for it", () => {
    const out = html(<LiabilityField name="Size" value="10" kind="attested" />);
    expect(out).toContain(">Size<");
    expect(out).toContain(">10<");
    expect(out).toContain("Operator-attested · bonded");
    expect(out).toContain('data-kind="attested"');
  });
});
