import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

type Fixture = { monitor: string; log: string; control: string };

let fixture: Fixture;
let proc: ChildProcess;
let browser: Browser;

// The Go test that serves the monitor over a real local log with witnesses.
async function startFixture(): Promise<Fixture> {
  proc = spawn(
    "go",
    ["test", "-tags", "page", "-run", "^TestPageFixture$", "-count=1", "-v", "-timeout", "0", "."],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "pipe", "inherit"] },
  );
  let out = "";
  return new Promise((resolve, reject) => {
    proc.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const m = out.match(/PAGE_FIXTURE (\{.*\})\n/);
      if (m?.[1]) resolve(JSON.parse(m[1]));
    });
    proc.on("exit", (code) => reject(new Error(`the page fixture exited with ${code}:\n${out}`)));
  });
}

beforeAll(async () => {
  [fixture, browser] = await Promise.all([startFixture(), chromium.launch()]);
});

afterAll(async () => {
  await browser?.close();
  if (proc && proc.exitCode === null) {
    const exited = once(proc, "exit");
    await fetch(`${fixture.control}/stop`, { method: "POST" }).catch(() => proc.kill());
    await exited;
  }
});

async function open(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(fixture.monitor);
  await page.locator("body[data-ready]").waitFor({ state: "attached" });
  return page;
}

async function check(page: Page, id: string): Promise<{ status: string; detail: string }> {
  const li = page.locator(`[data-check="${id}"]`);
  return {
    status: (await li.getAttribute("data-status")) ?? "",
    detail: (await li.locator(".detail").textContent()) ?? "",
  };
}

async function verdict(page: Page): Promise<string> {
  return (await page.locator("#verdict").getAttribute("data-state")) ?? "";
}

// Changes one base64 character of the checkpoint's root line.
function flipRoot(note: string): string {
  const lines = note.split("\n");
  const root = lines[2] ?? "";
  lines[2] = (root[0] === "A" ? "B" : "A") + root.slice(1);
  return lines.join("\n");
}

describe("the monitor page", () => {
  test("verifies the checkpoint, consistency with a previous load and inclusion in the browser", async () => {
    const context = await browser.newContext();
    const page = await open(context);
    expect(await verdict(page)).toBe("ok");
    expect((await check(page, "checkpoint")).status).toBe("ok");
    expect((await check(page, "checkpoint")).detail).toContain("size 30");
    expect((await check(page, "consistency")).status).toBe("skip");
    expect((await check(page, "inclusion")).status).toBe("ok");
    expect((await check(page, "leaf")).detail).toContain("mode: 2of2");

    const res = await fetch(`${fixture.control}/append?n=5`, { method: "POST" });
    expect(res.status).toBe(204);
    await page.reload();
    await page.locator("body[data-ready]").waitFor({ state: "attached" });
    expect(await verdict(page)).toBe("ok");
    const c = await check(page, "consistency");
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("size 35 extends size 30");
    await context.close();
  });

  test("lists the degraded leaf and verifies it as degraded", async () => {
    const context = await browser.newContext();
    const page = await open(context);
    await page.waitForFunction(() => document.querySelector('[data-field="degraded-count"]'));
    expect(await page.locator('[data-field="degraded-count"]').textContent()).toBe("1");
    await page.locator('button[data-index="7"]').click();
    await page.waitForFunction(
      () => document.querySelector("#verdict")?.getAttribute("data-state") !== "pending",
    );
    expect(await verdict(page)).toBe("ok");
    expect((await check(page, "leaf")).detail).toContain("mode: degraded");
    expect((await check(page, "inclusion")).detail).toContain("leaf 7");
    await context.close();
  });

  test("lists conformance drills apart from production equivocations", async () => {
    const context = await browser.newContext();
    const page = await open(context);
    await page.waitForFunction(() => document.querySelector("#eq-drills [data-equivocation]"));
    expect(await page.locator("#eq-production [data-equivocation]").count()).toBe(0);
    await context.close();
  });

  test("fails visibly when the checkpoint is altered", async () => {
    const context = await browser.newContext();
    await context.route(`${fixture.log}/checkpoint`, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, body: flipRoot(await res.text()) });
    });
    const page = await open(context);
    expect(await verdict(page)).toBe("fail");
    expect((await check(page, "checkpoint")).status).toBe("fail");
    await context.close();
  });

  test("fails visibly when a tile is altered", async () => {
    const context = await browser.newContext();
    await context.route(/\/tile\/0\/000(\.p\/\d+)?$/, async (route) => {
      const res = await route.fetch();
      const body = Buffer.from(await res.body());
      // A byte of leaf 1's hash, which is on the path of leaf 0.
      body[40] = (body[40] ?? 0) ^ 1;
      await route.fulfill({ response: res, body });
    });
    const page = await open(context);
    expect(await verdict(page)).toBe("fail");
    const c = await check(page, "inclusion");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("tile");
    await context.close();
  });

  test("fails visibly when the leaf is altered", async () => {
    const context = await browser.newContext();
    await context.route(/\/tile\/entries\//, async (route) => {
      const res = await route.fetch();
      const body = Buffer.from(await res.body());
      // One character of the first leaf's cart_hash, which keeps it well formed.
      const at = body.indexOf('"cart_hash":"') + '"cart_hash":"'.length;
      body[at] = body[at] === 0x41 ? 0x42 : 0x41;
      await route.fulfill({ response: res, body });
    });
    const page = await open(context);
    expect(await verdict(page)).toBe("fail");
    expect((await check(page, "leaf")).status).toBe("ok");
    expect((await check(page, "inclusion")).status).toBe("fail");
    await context.close();
  });

  test("renders at 360 px without horizontal scroll", async () => {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const page = await open(context);
    await page.waitForFunction(() => document.querySelector("[data-origin]"));
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(360);
    await context.close();
  });
});
