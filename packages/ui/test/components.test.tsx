import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { Button } from "../src/components/button.tsx";
import { LIABILITY, Liability, LiabilityMark } from "../src/components/liability.tsx";
import { STATUS, Status } from "../src/components/status.tsx";

const html = (node: React.ReactNode) => renderToStaticMarkup(node);

describe("Liability: color, shape and label, never color alone", () => {
  test.each([
    ["verified", "Keelson-verified", "square"],
    ["attested", "Operator-attested · bonded", "diamond"],
    ["yours", "Yours · not covered", "circle"],
  ] as const)("%s", (kind, label, shape) => {
    const out = html(<Liability kind={kind} />);
    expect(out).toContain(label);
    expect(out).toContain(`data-shape="${shape}"`);
    expect(out).toContain(`text-field-${kind}`);
    // The mark is decorative next to its text.
    expect(out).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  test("a mark alone is an image named by its label", () => {
    for (const kind of Object.keys(LIABILITY) as (keyof typeof LIABILITY)[]) {
      const out = html(<LiabilityMark kind={kind} />);
      expect(out).toContain('role="img"');
      expect(out).toContain(`aria-label="${LIABILITY[kind].label}"`);
    }
  });

  test("three distinct shapes", () => {
    expect(new Set(Object.values(LIABILITY).map((l) => l.shape)).size).toBe(3);
  });
});

describe("Status: vermilion means Keelson acted", () => {
  const states = Object.keys(STATUS) as (keyof typeof STATUS)[];

  test("every state shows its text", () => {
    for (const s of states) expect(html(<Status state={s} />)).toContain(`>${STATUS[s].text}<`);
  });

  test("only countersigned and blocked are filled vermilion", () => {
    for (const s of states) {
      const out = html(<Status state={s} />);
      expect(out.includes("bg-vermilion "), s).toBe(s === "countersigned" || s === "blocked");
    }
  });

  test("an error is graphite with a Vermilion Deep border and a '!', never vermilion", () => {
    const out = html(<Status state="error" />);
    expect(out).toContain(">!<");
    expect(out).toContain("border-vermilion-deep");
    expect(out).not.toContain("bg-vermilion");
    expect(out).toContain(">Error<");
  });
});

describe("Button", () => {
  test("a native button with its slot", () => {
    expect(html(<Button>Sign</Button>)).toMatch(/^<button[^>]*data-slot="button"/);
  });

  test("asChild renders the child element", () => {
    expect(
      html(
        <Button asChild>
          <a href="/judge">Open</a>
        </Button>,
      ),
    ).toMatch(/^<a[^>]*href="\/judge"[^>]*data-slot="button"|^<a[^>]*data-slot="button"/);
  });
});
