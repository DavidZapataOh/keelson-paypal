"use client";

import { Dashboard } from "../components/dashboard";
import { Welcome } from "../components/welcome";
import { authClient } from "../lib/auth";

export default function Home() {
  const { data, isPending } = authClient.useSession();
  if (isPending)
    return (
      <p className="sr-only" role="status">
        Loading…
      </p>
    );
  return data ? <Dashboard /> : <Welcome />;
}
