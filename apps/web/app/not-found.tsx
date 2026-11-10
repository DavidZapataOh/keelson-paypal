import { Button } from "@keelson/ui/components/button";
import Link from "next/link";
import { Eyebrow } from "../components/notice";

export default function NotFound() {
  return (
    <div className="grid max-w-3xl gap-5 py-16">
      <Eyebrow>404</Eyebrow>
      <h1 className="text-balance font-semibold text-4xl leading-[1.05] tracking-[-0.03em]">
        This page does not exist
      </h1>
      <p className="max-w-prose text-pretty text-lg text-muted-foreground">
        The link may be old or mistyped. Your mandates, purchases and Alibis are on the app's home.
      </p>
      <Button asChild size="lg" className="w-fit">
        <Link href="/">Go to the app</Link>
      </Button>
    </div>
  );
}
