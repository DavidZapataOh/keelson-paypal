import { InfoIcon, ReceiptIcon } from "lucide-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "../../src/components/alert.tsx";
import { Amount } from "../../src/components/amount.tsx";
import { Badge } from "../../src/components/badge.tsx";
import { BlockDiff } from "../../src/components/block-diff.tsx";
import { Button } from "../../src/components/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../src/components/card.tsx";
import { Checkbox } from "../../src/components/checkbox.tsx";
import { CopyValue } from "../../src/components/copy-value.tsx";
import { DataItem, DataList } from "../../src/components/data-list.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../src/components/dialog.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../src/components/empty.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "../../src/components/field.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "../../src/components/input-group.tsx";
import { Liability, LiabilityField, LiabilityMark } from "../../src/components/liability.tsx";
import { Meter } from "../../src/components/meter.tsx";
import { RadioGroup, RadioGroupItem } from "../../src/components/radio-group.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../src/components/select.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../../src/components/sheet.tsx";
import { Skeleton } from "../../src/components/skeleton.tsx";
import { Toaster } from "../../src/components/sonner.tsx";
import { STATUS, Status } from "../../src/components/status.tsx";
import { Switch } from "../../src/components/switch.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../src/components/table.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../src/components/tabs.tsx";
import { Textarea } from "../../src/components/textarea.tsx";
import { Timeline, TimelineItem } from "../../src/components/timeline.tsx";
import "./styles.css";

const fields = [
  { name: "Total ≤ $100.00", kind: "verified" },
  { name: "Merchant on the allowlist", kind: "verified" },
  { name: "Size 10", kind: "attested" },
  { name: "A color you will like", kind: "yours" },
] as const;

const purchases = [
  { id: "01M6W3TTKR", merchant: "Allbirds", total: "$84.00", state: "captured" },
  { id: "01M6W3V0QA", merchant: "Nike", total: "$340.00", state: "blocked" },
  { id: "01M6W3V7ZC", merchant: "REI", total: "$96.50", state: "countersigned" },
  { id: "01M6W3VB1D", merchant: "Allbirds", total: "$84.00", state: "disputed" },
  { id: "01M6W3VF8E", merchant: "Zappos", total: "$72.10", state: "error" },
] as const;

function Showcase() {
  return (
    <main className="mx-auto max-w-4xl space-y-12 px-6 py-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Proof before payment.</h1>
        <p className="text-muted-foreground">
          Every component of the Keelson design system, in its current theme.
        </p>
      </header>

      <section aria-labelledby="actions" className="space-y-3">
        <h2 id="actions" className="text-lg font-medium">
          Actions
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <Button>Sign the mandate</Button>
          <Button variant="secondary">Review fields</Button>
          <Button variant="outline">Open verifier</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="link">What Keelson does not do</Button>
          <Button disabled>Countersigning</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm">Export</Button>
          <Button size="sm" variant="outline">
            Filters
          </Button>
          <Button size="xs" variant="ghost">
            Reset filters
          </Button>
          <Badge>Sandbox</Badge>
          <Badge variant="secondary">Arbitrum Sepolia</Badge>
          <Badge variant="outline">PayPal sandbox</Badge>
        </div>
      </section>

      <section aria-labelledby="mandate">
        <Card>
          <CardHeader>
            <CardTitle id="mandate">Running shoes, up to $100</CardTitle>
            <CardDescription>
              Who answers for each field if the agent gets it wrong.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {fields.map((f) => (
                <li key={f.name} className="flex items-center justify-between gap-4 py-2.5">
                  <span>{f.name}</span>
                  <Liability kind={f.kind} />
                </li>
              ))}
            </ul>
          </CardContent>
          <CardFooter className="justify-between gap-4">
            <p className="font-mono text-sm tabular-nums">
              Mandate: max $100.00 · Cart: $340.00 ·{" "}
              <span className="text-destructive">Blocked</span>
            </p>
            <Status state="blocked" />
          </CardFooter>
        </Card>
      </section>

      <section aria-labelledby="matrix" className="space-y-3">
        <h2 id="matrix" className="text-lg font-medium">
          Field marks
        </h2>
        <div className="flex gap-4">
          <LiabilityMark kind="verified" />
          <LiabilityMark kind="attested" />
          <LiabilityMark kind="yours" />
        </div>
      </section>

      <section aria-labelledby="states" className="space-y-3">
        <h2 id="states" className="text-lg font-medium">
          Purchase states
        </h2>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(STATUS) as (keyof typeof STATUS)[]).map((s) => (
            <Status key={s} state={s} />
          ))}
        </div>
        <p className="font-mono text-sm text-muted-foreground">
          alibi 01M6W3TTKRC43V70XQAT1QQK6V · leaf 84712997ee424ff5
        </p>
      </section>

      <section aria-labelledby="alibi" className="grid gap-6 md:grid-cols-[1fr_18rem]">
        <Card className="gap-5">
          <CardHeader>
            <CardTitle id="alibi">Alibi · REI</CardTitle>
            <CardDescription>Countersigned before payment. Anyone can verify it.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Amount value={96.5} className="text-amount" />
              <Status state="countersigned" reveal />
            </div>
            <div className="divide-y divide-border border-y">
              <LiabilityField name="Total" value="$96.50 ≤ $100.00" kind="verified" />
              <LiabilityField name="Merchant" value="REI" kind="verified" />
              <LiabilityField name="Size" value="10" kind="attested" />
              <LiabilityField name="Color" value="Slate" kind="yours" />
            </div>
            <Meter label="Mandate used" value={96.5} max={100} format={(n) => `$${n.toFixed(2)}`} />
          </CardContent>
          <CardFooter className="flex-wrap justify-between gap-3">
            <CopyValue value="01M6W3V7ZCQ9R4H2K8T0XQAT1Q" label="Alibi ID" />
            <Button size="sm" variant="outline" asChild>
              <a href="#alibi">Verify this Alibi</a>
            </Button>
          </CardFooter>
        </Card>
        <div className="grid content-start gap-6">
          <DataList layout="stacked">
            <DataItem label="Agent">Shopper by Acme</DataItem>
            <DataItem label="Countersigned">
              <span className="font-mono text-sm tabular-nums">2026-11-09 14:02:09 UTC</span>
            </DataItem>
            <DataItem label="Log leaf">
              <CopyValue value="84712997ee424ff5a1b2c3d4e5f60718" label="Log leaf" short />
            </DataItem>
          </DataList>
          <Timeline aria-label="What happened">
            <TimelineItem state="done" actor="You" time="2026-11-09T14:01:52Z">
              signed the mandate
            </TimelineItem>
            <TimelineItem state="done" actor="Keelson" time="2026-11-09T14:02:09Z">
              checked the cart and countersigned
            </TimelineItem>
            <TimelineItem state="current" actor="PayPal">
              is capturing the payment
            </TimelineItem>
            <TimelineItem state="upcoming" actor="REI">
              ships the order
            </TimelineItem>
          </Timeline>
        </div>
      </section>

      <section aria-labelledby="block" className="space-y-3">
        <h2 id="block" className="text-lg font-medium">
          A blocked cart
        </h2>
        <BlockDiff field="Total" mandate="max $100.00" cart="$340.00" />
        <DataList className="max-w-sm">
          <DataItem label="Cart">
            <Amount value={340} struck="Blocked, not charged" />
          </DataItem>
          <DataItem label="Refunded">
            <Amount value={84} signed />
          </DataItem>
          <DataItem label="Bond slashed">
            <Amount value={-95} />
          </DataItem>
        </DataList>
        <Timeline aria-label="Blocked cart">
          <TimelineItem state="done" actor="Your agent" time="2026-11-09T15:10:00Z">
            asked to pay $340.00 at Nike
          </TimelineItem>
          <TimelineItem state="blocked" actor="Keelson" time="2026-11-09T15:10:01Z">
            blocked it: $340.00 is over the $100.00 cap
          </TimelineItem>
          <TimelineItem state="failed" actor="PayPal" time="2026-11-09T15:12:30Z">
            did not answer the refund request; retrying
          </TimelineItem>
        </Timeline>
      </section>

      <section aria-labelledby="form" className="space-y-4">
        <h2 id="form" className="text-lg font-medium">
          Mandate form
        </h2>
        <FieldGroup className="max-w-md">
          <Field>
            <FieldLabel htmlFor="what">What the agent may buy</FieldLabel>
            <Textarea id="what" defaultValue="Running shoes, men's size 10, neutral colors." />
            <FieldDescription>
              One sentence. Keelson turns it into checkable fields.
            </FieldDescription>
          </Field>
          <Field data-invalid>
            <FieldLabel htmlFor="max">Maximum total</FieldLabel>
            <InputGroup>
              <InputGroupAddon>
                <InputGroupText>$</InputGroupText>
              </InputGroupAddon>
              <InputGroupInput
                id="max"
                inputMode="decimal"
                defaultValue="0"
                aria-invalid
                aria-describedby="max-error"
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText>USD</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
            <FieldError id="max-error">Enter an amount above $0.00.</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="window">Valid for</FieldLabel>
            <Select defaultValue="7d">
              <SelectTrigger id="window" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1d">24 hours</SelectItem>
                <SelectItem value="7d">7 days</SelectItem>
                <SelectItem value="30d">30 days</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <RadioGroup defaultValue="once" aria-label="How often">
            <Field orientation="horizontal">
              <RadioGroupItem value="once" id="once" />
              <FieldLabel htmlFor="once">One purchase</FieldLabel>
            </Field>
            <Field orientation="horizontal">
              <RadioGroupItem value="many" id="many" />
              <FieldLabel htmlFor="many">Several purchases, same cap</FieldLabel>
            </Field>
          </RadioGroup>
          <Field orientation="horizontal">
            <Checkbox id="gray" defaultChecked />
            <FieldLabel htmlFor="gray">I read the gray fields: they are mine.</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Switch id="notify" />
            <FieldLabel htmlFor="notify">Email me when Keelson blocks a cart</FieldLabel>
          </Field>
        </FieldGroup>
      </section>

      <section aria-labelledby="overlays" className="space-y-3">
        <h2 id="overlays" className="text-lg font-medium">
          Overlays
        </h2>
        <div className="flex flex-wrap gap-3">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Revoke mandate</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Revoke this mandate?</DialogTitle>
                <DialogDescription>
                  Your agent can no longer buy with <strong>Running shoes, up to $100</strong>.
                  Purchases already countersigned stay covered.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Keep it</Button>
                </DialogClose>
                <Button>Revoke mandate</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline">Open purchase</Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Nike · $340.00</SheetTitle>
                <SheetDescription>Blocked before payment. Nothing reached PayPal.</SheetDescription>
              </SheetHeader>
              <div className="px-4">
                <Status state="blocked" />
              </div>
              <SheetFooter>
                <Button variant="outline">Open the Alibi</Button>
              </SheetFooter>
            </SheetContent>
          </Sheet>
          <Button
            variant="outline"
            onClick={() =>
              toast.success("Mandate signed", { description: "Your agent can buy up to $100.00." })
            }
          >
            Show a toast
          </Button>
        </div>
        <Alert variant="attention" role="status">
          <InfoIcon />
          <AlertTitle>Bond below minimum</AlertTitle>
          <AlertDescription>
            Two attestations were disputed this week. Top up to $500.00.
          </AlertDescription>
        </Alert>
      </section>

      <section aria-labelledby="purchases" className="space-y-3">
        <h2 id="purchases" className="text-lg font-medium">
          Purchases
        </h2>
        <Tabs defaultValue="all">
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="blocked">Blocked</TabsTrigger>
            <TabsTrigger value="loading">Loading</TabsTrigger>
            <TabsTrigger value="empty">Disputed</TabsTrigger>
          </TabsList>
          <TabsContent value="all">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Purchase</TableHead>
                  <TableHead>Merchant</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {purchases.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-muted-foreground">{p.id}</TableCell>
                    <TableCell>{p.merchant}</TableCell>
                    <TableCell>
                      <Status state={p.state} appearance="inline" />
                    </TableCell>
                    <TableCell className="text-right font-mono">{p.total}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TabsContent>
          <TabsContent value="blocked">
            <p className="py-4 text-muted-foreground">One blocked purchase.</p>
          </TabsContent>
          <TabsContent value="loading">
            <div
              className="space-y-3 py-3"
              role="status"
              aria-busy="true"
              aria-label="Loading purchases"
            >
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          </TabsContent>
          <TabsContent value="empty">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ReceiptIcon />
                </EmptyMedia>
                <EmptyTitle>No disputes</EmptyTitle>
                <EmptyDescription>
                  When a buyer disputes an agent purchase, it appears here with its Alibi.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button size="sm" variant="outline">
                  How disputes work
                </Button>
              </EmptyContent>
            </Empty>
          </TabsContent>
        </Tabs>
      </section>
      <Toaster />
    </main>
  );
}

if (new URLSearchParams(location.search).get("theme") === "dark") {
  document.documentElement.classList.add("dark");
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Showcase />
  </StrictMode>,
);
