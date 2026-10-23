import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { auditM9Conservative, renderM9ConservativeAudit } from "../../src/evaluation/m9-conservative";

// Fixed M8 DEV24 author-created recording. No arbitrary path, split, execute,
// provider, permit, or live mode can be selected through this offline CLI.
if (process.argv.length !== 2) throw new Error("M9_OFFLINE_FIXED_DEV24_ACCEPTS_NO_ARGUMENTS");
const inputPath = path.resolve("tests/evaluation/m7/math-candidates.inputs.json");
const runPath = path.resolve(".local/m7-conversation/simulate-2026-10-23T13-03-45-796Z-8ba2e0eb-1442-4626-b79e-b9f6669ffb3f/run.json");
const datasetBytes = await readFile(inputPath), runBytes = await readFile(runPath);
const inputFileSha256 = createHash("sha256").update(datasetBytes).digest("hex");
if (inputFileSha256 !== "ab0b0913d6bfee640f7833a50f803f47ce2ab48ba61b1bfceb4ecc9877f3bb6e") throw new Error("M9_FIXED_M7_DATASET_BYTES_MISMATCH");
const runFileSha256 = createHash("sha256").update(runBytes).digest("hex");
if (runFileSha256 !== "60d830d4afe3dc71e0c87cf177c86606a433bc0d8d830708bf257f96bc4e418c") throw new Error("M9_FIXED_M8_DEV24_RECORDING_BYTES_MISMATCH");
const audit = auditM9Conservative(JSON.parse(datasetBytes.toString("utf8")), JSON.parse(runBytes.toString("utf8")));
if (audit.runId !== "590d8175-0c16-41cb-971f-62cf831d04a1" || audit.datasetHash !== "241f0a5821f7310d5a8073a48af83af31d8fb9b0369a23875a6e59c35a6b707e" || audit.totals.scheduledCases !== 24 || audit.rows.some((row, index) => row.caseId !== `m7-d${String(index + 1).padStart(2, "0")}`)) throw new Error("M9_FIXED_M8_DEV24_BINDING_MISMATCH");
const outputDirectory = path.resolve(".local/m9-conservative", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
await mkdir(outputDirectory, { recursive: true });
const sourceBindings = { inputPath: path.relative(process.cwd(), inputPath), runPath: path.relative(process.cwd(), runPath),
  inputFileSha256, runFileSha256 };
const { teacherQueue, ...summary } = audit;
await writeFile(path.join(outputDirectory, "audit.json"), JSON.stringify({ ...summary, sourceBindings }, null, 2) + "\n", { flag: "wx" });
await writeFile(path.join(outputDirectory, "teacher-question-queue.json"), JSON.stringify({ schemaVersion: "M9.1", state: "PENDING_ACTUAL_TEACHER_REVIEW", runId: audit.runId, datasetHash: audit.datasetHash, runHash: audit.runHash, sourceBindings, cases: teacherQueue }, null, 2) + "\n", { flag: "wx" });
await writeFile(path.join(outputDirectory, "audit.md"), renderM9ConservativeAudit(audit), { flag: "wx" });
console.log(JSON.stringify({ status: "OFFLINE_AUDITED_TEACHER_PENDING", outputDirectory, sourceBindings, totals: audit.totals, networkRequests: 0, newProviderCostCny: 0, teacherReviewedCases: 0, formalQuality: null }, null, 2));
