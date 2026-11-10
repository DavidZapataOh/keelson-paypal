import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { Alert, AlertTitle } from "../src/components/alert.tsx";
import { Button } from "../src/components/button.tsx";
import { Field, FieldError, FieldLabel } from "../src/components/field.tsx";
import { Input } from "../src/components/input.tsx";
import { LIABILITY, Liability, LiabilityMark } from "../src/components/liability.tsx";
import { STATUS, Status } from "../src/components/status.tsx";
import { cn } from "../src/lib/utils.ts";

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

describe("Status in table cells", () => {
  test("inline drops the chip but keeps glyph, word and tone", () => {
    const out = html(<Status state="blocked" appearance="inline" />);
    expect(out).toContain('data-appearance="inline"');
    expect(out).toContain(">Blocked<");
    expect(out).toContain("<svg");
    expect(out).not.toContain("border");
    expect(out).not.toContain("bg-vermilion");
  });

  test("the countersign reveal is opt-in and motion-safe", () => {
    expect(html(<Status state="countersigned" />)).not.toContain("animate-reveal");
    expect(html(<Status state="countersigned" reveal />)).toContain("motion-safe:animate-reveal");
  });
});

describe("Field", () => {
  test("an invalid field marks its label and shows the error", () => {
    const out = html(
      <Field data-invalid>
        <FieldLabel htmlFor="max">Maximum</FieldLabel>
        <Input id="max" aria-invalid aria-describedby="max-error" />
        <FieldError id="max-error">Enter an amount above $0.00.</FieldError>
      </Field>,
    );
    expect(out).toContain('data-invalid="true"');
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('role="alert"');
    expect(out).toContain("Enter an amount above $0.00.");
  });

  test("inputs are 44 px by default", () => {
    expect(html(<Input />)).toContain("h-11");
  });
});

describe("Button sizes", () => {
  test.each([
    ["default", "h-11"],
    ["sm", "h-8"],
    ["xs", "h-7"],
    ["lg", "h-12"],
  ] as const)("%s is %s", (size, cls) => {
    expect(html(<Button size={size}>Go</Button>)).toContain(cls);
  });
});

describe("Alert tones never fill vermilion or green", () => {
  test.each(["default", "attention", "destructive"] as const)("%s", (variant) => {
    const out = html(
      <Alert variant={variant}>
        <AlertTitle>Bond below minimum</AlertTitle>
      </Alert>,
    );
    expect(out).not.toMatch(/bg-(vermilion|ok|destructive)\b/);
  });
});

describe("cn", () => {
  test("keeps a text color next to the custom font sizes", () => {
    expect(cn("text-primary-foreground", "text-ui")).toBe("text-primary-foreground text-ui");
    expect(cn("text-sm", "text-ui")).toBe("text-ui");
  });
});
