import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import webpush from "web-push";

const envPath = resolve(process.cwd(), ".env");
let source = await readFile(envPath, "utf8");
const publicKey = valueOf(source, "VAPID_PUBLIC_KEY");
const privateKey = valueOf(source, "VAPID_PRIVATE_KEY");

if (publicKey && privateKey) {
  console.log("VAPID keys are already configured; nothing changed.");
} else {
  if (publicKey || privateKey) throw new Error("Only one VAPID key is set. Set both keys together or clear both values before generating a new pair.");

  const keys = (webpush as typeof webpush & { generateVAPIDKeys(): { publicKey: string; privateKey: string } }).generateVAPIDKeys();
  source = setValue(source, "VAPID_PUBLIC_KEY", keys.publicKey);
  source = setValue(source, "VAPID_PRIVATE_KEY", keys.privateKey);
  await writeFile(envPath, source);
  console.log("Generated VAPID keys in backend/.env. The key values were not printed.");
}

function valueOf(source: string, name: string) {
  return source.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim() ?? "";
}

function setValue(source: string, name: string, value: string) {
  const expression = new RegExp(`^${name}=.*$`, "m");
  return expression.test(source) ? source.replace(expression, `${name}=${value}`) : `${source.trimEnd()}\n${name}=${value}\n`;
}
