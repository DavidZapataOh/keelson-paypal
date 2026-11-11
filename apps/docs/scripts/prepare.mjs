import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repo = (p) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const pub = (p) => fileURLToPath(new URL(`../public/${p}`, import.meta.url));

const yaml = readFileSync(repo("openapi/keelson.yaml"), "utf8");
writeFileSync(pub("openapi.yaml"), yaml);
writeFileSync(pub("openapi.json"), `${JSON.stringify(parse(yaml), null, 2)}\n`);

mkdirSync(pub("samples"), { recursive: true });
for (const id of ["01M6ZWZJHWRRHQEYNJAT7NMSV8", "01M6ZX07MFWDDDW4199FDJHWEG"]) {
  copyFileSync(repo(`packages/alibi/test/fixtures/${id}.alibi`), pub(`samples/${id}.alibi`));
}
