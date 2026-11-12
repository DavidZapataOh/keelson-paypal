#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { credentialsPath, readCredentials, storedLogin } from "./credentials.ts";
import { login } from "./login.ts";

const USAGE = `Usage: keelson <command>

  login    Sign in to Keelson in your browser and save the sign-in
  whoami   Show who you are signed in as, and what you may do
  logout   Forget the saved sign-in`;

function claims(token: string): { sub?: string; scope?: string } {
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as {
    sub?: string;
    scope?: string;
  };
}

const [command] = process.argv.slice(2);
try {
  if (command === "login") {
    await login();
  } else if (command === "whoami") {
    if (!(await readCredentials())) throw new Error("Not signed in. Run `npx keelson login`.");
    const c = claims(await storedLogin().token());
    console.log(`user   ${c.sub}\nscopes ${c.scope}`);
  } else if (command === "logout") {
    await rm(credentialsPath(), { force: true });
    console.log("Signed out.");
  } else {
    console.log(USAGE);
    process.exitCode = command && command !== "help" && command !== "--help" ? 2 : 0;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
