import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hashValue } from "../../src/evaluation/schemas";
import { buildM9Pilot, buildM9PilotPackets, M9_FROZEN_PARENT, renderM9PilotChecklist, renderM9PilotPacket, validateM9PilotPacket } from "../../src/evaluation/m9-pilot";

// Offline prepare/validate only. No gateway, provider calls, deletion or identity generation.
const frozenDirectory = path.resolve("tests/evaluation/m7");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
const frozenManifestSchema = z.object({ datasetHash: z.literal(M9_FROZEN_PARENT.datasetHash), fileHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) });
async function frozenSnapshot() {
  const bytes = await readFile(path.join(frozenDirectory, "hashmanifest.json"));
  if (sha256(bytes) !== M9_FROZEN_PARENT.manifestFileHash) throw new Error("M9_FROZEN_MANIFEST_BYTES_MISMATCH");
  const manifest = frozenManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  const files: Record<string, string> = { "hashmanifest.json": sha256(bytes) };
  for (const [name, expected] of Object.entries(manifest.fileHashes)) {
    if (path.basename(name) !== name) throw new Error("M9_INVALID_FROZEN_FILE_NAME");
    const actual = sha256(await readFile(path.join(frozenDirectory, name)));
    if (actual !== expected) throw new Error(`M9_FROZEN_FILE_BYTES_MISMATCH:${name}`);
    files[name] = actual;
  }
  return files;
}
async function readJson(file: string): Promise<unknown> { return JSON.parse(await readFile(file, "utf8")); }
async function main() {
  const [command = "prepare", ...args] = process.argv.slice(2);
  if (command !== "prepare" && command !== "validate" || command === "prepare" && args.length !== 0 || command === "validate" && args.length !== 1) throw new Error("用法: m9-pilot.ts prepare | validate existing-pilot-directory");
  const before = await frozenSnapshot();
  const parent = await readJson(path.join(frozenDirectory, "math-candidates.inputs.json"));
  const pilot = buildM9Pilot(parent);
  const directory = path.resolve(".local/m9-pilot", `${command}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  async function save(name: string, value: unknown) {
    await writeFile(path.join(directory, name), typeof value === "string" ? value : jsonBytes(value), { flag: "wx" });
  }
  const sourceDirectory = command === "prepare" ? directory : path.resolve(args[0]);
  if (command === "prepare") {
    const prepared = buildM9PilotPackets(parent);
    const bytes = jsonBytes(prepared.dataset);
    await save("pilot.inputs.json", prepared.dataset);
    const packetBindings = {} as Record<"A" | "B", { packetId: string; packetHash: string }>;
    for (const slot of ["A", "B"] as const) {
      const reviewer = prepared.reviewers[slot], prefix = `teacher-${slot.toLowerCase()}`;
      await mkdir(path.join(directory, prefix));
      await save(`${prefix}/packet.json`, reviewer.packet);
      await save(`${prefix}/packet.md`, renderM9PilotPacket(reviewer.packet));
      await save(`${prefix}/review.form.json`, reviewer.form);
      await save(`${prefix}/usability.form.json`, reviewer.usability);
      await save(`${prefix}/checklist.md`, renderM9PilotChecklist());
      packetBindings[slot] = { packetId: reviewer.packet.packetId, packetHash: hashValue(reviewer.packet) };
    }
    await save("administrator-manifest.json", {
      schemaVersion: "M9.1", purpose: "TEACHER_USABILITY_PILOT", status: "PROVISIONAL", humanReviewState: "PENDING_HUMAN_REVIEW", formalGold: false,
      parent: { datasetId: M9_FROZEN_PARENT.datasetId, version: M9_FROZEN_PARENT.version, datasetHash: pilot.parentDatasetHash, exactFileHashes: before },
      child: { datasetId: pilot.dataset.datasetId, version: pilot.dataset.version, datasetHash: pilot.childDatasetHash, inputFileHash: sha256(bytes) },
      selection: pilot.selection, scenarioCounts: pilot.scenarioCounts, caseCount: 10, packetBindings,
      canonicalHashAlgorithm: "SHA-256 of sorted-key canonical JSON (hashValue)", fileHashAlgorithm: "SHA-256 of exact UTF-8 bytes",
    });
    await save("administrator-handoff.md", ["# M9 负责人交接", "",
      "当前仅生成10例DEV可用性试标空表，PROVISIONAL / PENDING_HUMAN_REVIEW，实际审核、签收均待完成。",
      "只分别分发teacher-a或teacher-b对应目录；根目录inputs、manifest和本文件含作者场景元数据，不能分发给教师。",
      "两位教师先独立解题及解释，再填写原输入表及可用性表；耗时和费力度只收实际填写。", "",
      "- [A 材料](teacher-a/packet.md) / [A 清单](teacher-a/checklist.md)",
      "- [B 材料](teacher-b/packet.md) / [B 清单](teacher-b/checklist.md)",
      `- [原意见保留、独立第三人及签署来源核验](<${path.resolve("docs/M8-教师独立审核与指标.md")}>)`,
      `- [M9 试标说明](<${path.resolve("docs/M9-教师试标说明.md")}>)`, "",
      "接收时保留每份原件和字节hash，不覆盖；M9 validate只检查结构、绑定和引文，不认证身份，不自动认定任何教师已审核。",
      "歧义/异议先收集，不自动并成一致。使用M8 attach-source→人工核实→compare；分歧由独立第三人adjudicate并真实签署，保留A/B原文。",
      "dissentRecordRef和thirdPartyArbitrationRef先留空，待实际原件存在后记录私有引用。不得填造身份、时间或签名。",
      "现实访问隔离依赖负责人分别分发和控制权限，本次未验证真实签收或存储隔离。无正式金标冻结、无模型调用授权。",
    ].join("\n") + "\n");
  }
  const manifest = await readJson(path.join(sourceDirectory, "administrator-manifest.json")) as Record<string, unknown>;
  const childBytes = await readFile(path.join(sourceDirectory, "pilot.inputs.json"));
  const expectedChild = { datasetId: pilot.dataset.datasetId, version: pilot.dataset.version, datasetHash: pilot.childDatasetHash, inputFileHash: sha256(childBytes) };
  const expectedParent = { datasetId: M9_FROZEN_PARENT.datasetId, version: M9_FROZEN_PARENT.version, datasetHash: pilot.parentDatasetHash, exactFileHashes: before };
  if (manifest.schemaVersion !== "M9.1" || manifest.purpose !== "TEACHER_USABILITY_PILOT" || manifest.status !== "PROVISIONAL" || manifest.humanReviewState !== "PENDING_HUMAN_REVIEW" || manifest.formalGold !== false || manifest.caseCount !== 10 || hashValue(manifest.parent) !== hashValue(expectedParent) || hashValue(manifest.child) !== hashValue(expectedChild) || hashValue(manifest.selection) !== hashValue(pilot.selection) || hashValue(manifest.scenarioCounts) !== hashValue(pilot.scenarioCounts) || hashValue(JSON.parse(childBytes.toString("utf8"))) !== pilot.childDatasetHash) throw new Error("M9_PILOT_LINEAGE_OR_CHILD_MISMATCH");
  const bindings = z.strictObject({ A: z.strictObject({ packetId: z.string(), packetHash: z.string() }), B: z.strictObject({ packetId: z.string(), packetHash: z.string() }) }).parse(manifest.packetBindings);
  const reviewers = [];
  for (const slot of ["A", "B"] as const) {
    const prefix = path.join(sourceDirectory, `teacher-${slot.toLowerCase()}`);
    const validated = validateM9PilotPacket(pilot.dataset, await readJson(path.join(prefix, "packet.json")), await readJson(path.join(prefix, "review.form.json")), await readJson(path.join(prefix, "usability.form.json")));
    if (validated.packet.reviewerSlot !== slot || hashValue(bindings[slot]) !== hashValue({ packetId: validated.packet.packetId, packetHash: hashValue(validated.packet) })) throw new Error("M9_REVIEWER_MANIFEST_BINDING_MISMATCH");
    reviewers.push({ slot, caseCount: validated.packet.cases.length, formState: validated.form.status, usabilityState: validated.usability.state });
  }
  if (bindings.A.packetId === bindings.B.packetId) throw new Error("M9_DISTINCT_PACKETS_REQUIRED");
  const after = await frozenSnapshot();
  if (hashValue(before) !== hashValue(after)) throw new Error("M9_FROZEN_FILES_CHANGED_DURING_COMMAND");
  const validation = {
    schemaVersion: "M9.1", createdAt: new Date().toISOString(), status: "PASS", action: command,
    pilotState: "PROVISIONAL", humanReviewState: "PENDING_HUMAN_REVIEW", sourceDirectory, reviewers,
    parentDatasetHash: pilot.parentDatasetHash, childDatasetHash: pilot.childDatasetHash, selectedCaseIds: pilot.selection.map(row => row.caseId),
    scenarioCounts: pilot.scenarioCounts, frozenM7FileHashes: after, frozenFilesUnchanged: true,
    providerCalls: 0, paidCalls: 0, signaturesGenerated: 0, humanReviewsVerifiedByThisCommand: 0, teacherIdentityOrSignatureVerified: false, formalQuality: null,
  };
  await save("validation.json", validation);
  console.log(JSON.stringify({ directory, ...validation }, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
