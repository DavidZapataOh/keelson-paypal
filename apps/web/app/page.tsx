"use client";

import { Dashboard } from "../components/dashboard";
import { Welcome } from "../components/welcome";
import { authClient } from "../lib/auth";

export default function Home() {
  const { data, isPending } = authClient.useSession();
  if (data) return <Dashboard />;
  // The welcome is in the static HTML, so a visitor sees it at once; a browser that was signed in
  // hides it (html[data-session]) until its session is read.
  return (
    <div className={isPending ? "pending-session" : undefined}>
      <Welcome />
    </div>
  );
}
