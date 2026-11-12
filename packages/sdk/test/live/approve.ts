// Plays the user for another language's live tests: node approve.ts <login|request|hold|deny> <url>
import { judge } from "./user.ts";

const [command, url] = process.argv.slice(2);
if (!command || !url) {
  console.error("usage: node approve.ts <login|request|hold|deny> <url>");
  process.exit(2);
}
const user = await judge();
try {
  if (command === "login") await user.approveLogin(url);
  else if (command === "request") await user.approveRequest(url);
  else if (command === "hold") await user.approveRequest(url, { hold: true });
  else if (command === "deny") await user.denyRequest(url);
  else throw new Error(`unknown command ${command}`);
} finally {
  await user.close();
}
