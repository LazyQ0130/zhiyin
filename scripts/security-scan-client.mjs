import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const bundleRoot = path.resolve(root, process.argv[2] ?? ".next/static");
// A development compilation is not evidence for the production client bundle.
try {
  const buildId = await readFile(path.join(path.dirname(bundleRoot), "BUILD_ID"), "utf8");
  if (!buildId.trim()) throw new Error("EMPTY_BUILD_ID");
} catch {
  console.error("Client secret scan requires a completed production build (BUILD_ID missing). Pass its static directory.");
  process.exit(2);
}
const secretNames = [
  "ALIYUN_API_KEY", "DASHSCOPE_API_KEY", "DEEPSEEK_API_KEY", "SESSION_SECRET", "DATABASE_URL",
  "S3_SECRET_ACCESS_KEY", "S3_ACCESS_KEY_ID",
];
const secrets = new Set();
for (const name of secretNames) {
  if (process.env[name]?.length >= 12) secrets.add(process.env[name]);
}
for (const envFile of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  let contents;
  try { contents = await readFile(path.join(root, envFile), "utf8"); }
  catch (error) { if (error.code === "ENOENT") continue; throw error; }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)\s*=\s*["']?(.+?)["']?\s*$/);
    if (match && secretNames.includes(match[1]) && match[2].length >= 12
      && !/replace|example|your[-_]|changeme/i.test(match[2])) secrets.add(match[2]);
  }
}
async function files(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(full));
    else if (/\.(?:js|json|css|html|map)$/.test(entry.name)) output.push(full);
  }
  return output;
}
const leaks = [];
let scanned = 0;
try {
  for (const file of await files(bundleRoot)) {
    scanned++;
    const contents = await readFile(file, "utf8");
    const exactSecret = [...secrets].some((secret) => contents.includes(secret));
    const keyPattern = /\bsk-[a-zA-Z0-9_-]{24,}\b/.test(contents);
    const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(contents);
    if (exactSecret || keyPattern || privateKey) leaks.push(path.relative(root, file));
  }
} catch (error) {
  console.error(`Client secret scan could not run: ${error.code ?? "READ_ERROR"}. Build first.`);
  process.exitCode = 2;
}
if (!process.exitCode) {
  // Never print matched values or source excerpts: findings may contain secrets.
  console.log(JSON.stringify({ productionStaticDirectory: path.relative(root, bundleRoot), scannedFiles: scanned, secretValueChecks: secrets.size, leakingFiles: leaks, passed: scanned > 0 && leaks.length === 0 }, null, 2));
  if (scanned === 0 || leaks.length > 0) process.exitCode = 1;
}
