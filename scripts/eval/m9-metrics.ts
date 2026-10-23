import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { M9_MEASURE_SPECIFICATION, buildM9SupplementalPackets, compareM9SupplementalReviews, createM9SupplementalDecision, isM9HumanVerifiedSupplementalDecision, m9SupplementalAdjudicationPayload, scoreM9Evaluation, validateM9SupplementalForm } from "../../src/evaluation/m9-metrics";
import { m9SupplementalArtifactSchema, m9SupplementalDecisionSchema } from "../../src/evaluation/m9-metrics-schemas";
import { renderM8TeacherPacket } from "../../src/evaluation/m8-teacher";
import { hashValue } from "../../src/evaluation/schemas";

// Offline CLI. UUID directories + exclusive writes; no providers or deletions.
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = async (file: string): Promise<unknown> => JSON.parse(await readFile(path.resolve(file), "utf8"));
async function frozenHashes() {
  const directory = path.resolve("tests/evaluation/m7"), bytes = await readFile(path.join(directory, "hashmanifest.json"));
  const manifest = JSON.parse(bytes.toString("utf8")) as { fileHashes: Record<string, string> };
  const hashes: Record<string, string> = { "hashmanifest.json": sha(bytes) };
  for (const [name, expected] of Object.entries(manifest.fileHashes)) {
    if (path.basename(name) !== name) throw new Error("M9_INVALID_MANIFEST_PATH");
    const actual = sha(await readFile(path.join(directory, name)));
    if (actual !== expected) throw new Error(`M9_FROZEN_FILE_MISMATCH:${name}`);
    hashes[name] = actual;
  }
  return hashes;
}
const optionsSchema = z.strictObject({
  schemaVersion: z.literal("M9.1"), goldDecisionsFile: z.string().min(1).optional(), outputDecisionsFile: z.string().min(1).optional(), supplementalDecisionsFile: z.string().min(1).optional(), signedSourceFiles: z.array(z.string().min(1)).default([]),
});
async function main() {
  const [command = "help", ...args] = process.argv.slice(2), before = await frozenHashes();
  const directory = path.resolve(".local/m9-metrics", `${command}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const save = (name: string, value: unknown) => writeFile(path.join(directory, name), typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  let summary: unknown;
  if (command === "prepare") {
    if (args.length !== 2) throw new Error("用法: m9-metrics.ts prepare inputs.json recorded-run.json");
    const packets = buildM9SupplementalPackets(await json(args[0]), await json(args[1]));
    for (const slot of ["A", "B"] as const) {
      const base = `teacher-${slot.toLowerCase()}`, { packet, form } = packets[slot];
      await mkdir(path.join(directory, base));
      await save(`${base}/supplemental.packet.json`, packet);
      await save(`${base}/supplemental.form.json`, form);
      const specification = Object.entries(M9_MEASURE_SPECIFICATION).map(([key, spec]) => `- ${key} (${spec.unit}): 适用=${spec.eligibility}；分子=${spec.numeratorDefinition}`).join("\n");
      await save(`${base}/supplemental.packet.md`, `# M9补充人工编码 ${slot}\n\n当前未审、未签署。specificationHash=${packet.specificationHash}\n\n${packet.rules.map(rule => `- ${rule}`).join("\n")}\n\n${specification}\n\n${renderM8TeacherPacket(packet.m8Packet)}`);
      validateM9SupplementalForm(packet, form);
    }
    await save("measure-specification.json", M9_MEASURE_SPECIFICATION);
    summary = { action: "BLANK_SUPPLEMENTAL_PACKETS_ONLY", caseCountPerReviewer: packets.A.form.cases.length, helpTurnCountPerReviewer: packets.A.form.cases.reduce((sum, row) => sum + row.helpTurns.length, 0), actualTeacherReviews: 0, actualSignaturesGenerated: 0 };
  } else if (command === "validate") {
    if (args.length !== 2) throw new Error("用法: m9-metrics.ts validate supplemental.packet.json supplemental.form.json");
    const { form } = validateM9SupplementalForm(await json(args[0]), await json(args[1]));
    summary = { action: "FORM_HASH_AND_EVIDENCE_BINDINGS_ONLY", status: form.status, caseCount: form.cases.length, computerVerifiedIdentityOrSignature: false };
  } else if (command === "attach-source") {
    if (args.length !== 3) throw new Error("用法: m9-metrics.ts attach-source packet.json submitted.form.json actual-signed-source");
    const { packet, form } = validateM9SupplementalForm(await json(args[0]), await json(args[1]));
    if (form.status !== "SUBMITTED") throw new Error("M9_ACTUAL_SUBMITTED_FORM_REQUIRED");
    const bytes = await readFile(path.resolve(args[2]));
    const artifact = m9SupplementalArtifactSchema.parse({ schemaVersion: "M9.1", packet, submission: form, submissionHash: hashValue(form), signedSource: { sourceHash: sha(bytes), byteLength: bytes.length, mediaType: "application/octet-stream" }, humanAudit: { state: "PENDING_HUMAN_AUDIT", verifierPseudonym: null, verifiedAt: null, boundSubmissionHash: null, actualTeacherAndSignatureConfirmed: false, auditNote: "" } });
    await writeFile(path.join(directory, "original-signed-source.bin"), bytes, { flag: "wx" });
    await save("supplemental.source-audit.json", artifact);
    summary = { action: "ACTUAL_SOURCE_BYTES_ATTACHED_PENDING_HUMAN_AUDIT", sourceHash: artifact.signedSource.sourceHash, computerVerifiedIdentityOrSignature: false };
  } else if (command === "validate-audit") {
    if (args.length !== 2) throw new Error("用法: m9-metrics.ts validate-audit supplemental.source-audit.json actual-signed-source");
    const artifact = m9SupplementalArtifactSchema.parse(await json(args[0]));
    validateM9SupplementalForm(artifact.packet, artifact.submission);
    const bytes = await readFile(path.resolve(args[1]));
    if (sha(bytes) !== artifact.signedSource.sourceHash || bytes.length !== artifact.signedSource.byteLength) throw new Error("M9_SIGNED_SOURCE_BYTES_MISMATCH");
    summary = { action: "SOURCE_BYTES_AND_BINDINGS_MATCH", sourceAuditState: artifact.humanAudit.state, computerVerifiedIdentityOrSignature: false };
  } else if (command === "compare") {
    if (args.length !== 2) throw new Error("用法: m9-metrics.ts compare audit-a.json audit-b.json");
    const compared = compareM9SupplementalReviews(await json(args[0]), await json(args[1]));
    await save("originals-and-disagreements.json", compared);
    summary = { action: "ORIGINALS_PRESERVED", caseCount: compared.length, disagreementCount: compared.filter(row => !row.agrees).length };
  } else if (command === "agree" || command === "adjudicate") {
    if (args.length !== (command === "agree" ? 3 : 5)) throw new Error("用法: agree audit-a.json audit-b.json caseId | adjudicate audit-a.json audit-b.json caseId actual-third-pseudonym reason");
    const decision = createM9SupplementalDecision(await json(args[0]), await json(args[1]), args[2], command === "adjudicate" ? { reviewerPseudonym: args[3], reason: args[4] } : undefined);
    await save(`${command}.decision.json`, decision);
    summary = { action: command === "agree" ? "AGREEMENT_FROM_BOUND_HUMAN_AUDIT_CLAIMS" : "THIRD_REVIEWER_UNSIGNED_DRAFT_ONLY", state: decision.state, actualSignaturesGenerated: 0 };
  } else if (command === "attach-adjudication-source") {
    if (args.length !== 2) throw new Error("用法: m9-metrics.ts attach-adjudication-source filled-decision.json actual-third-signed-source");
    const decision = m9SupplementalDecisionSchema.parse(await json(args[0]));
    if (!decision.final || !decision.adjudication?.reviewedAt) throw new Error("M9_ACTUAL_FINAL_AND_REVIEW_TIME_REQUIRED");
    const original = decision.originals[0];
    validateM9SupplementalForm(original.packet, { ...original.submission, cases: original.submission.cases.map(row => row.caseId === decision.caseId ? decision.final : row) });
    const bytes = await readFile(path.resolve(args[1]));
    decision.state = "DRAFT_ADJUDICATION";
    Object.assign(decision.adjudication, { signedSourceHash: sha(bytes), signedSourceByteLength: bytes.length, humanAudit: "PENDING_HUMAN_AUDIT", verifierPseudonym: null, verifiedAt: null, actualTeacherAndSignatureConfirmed: false, adjudicationPayloadHash: hashValue(m9SupplementalAdjudicationPayload(decision)) });
    await writeFile(path.join(directory, "third-original-signed-source.bin"), bytes, { flag: "wx" });
    await save("adjudication.source-audit.json", decision);
    summary = { action: "THIRD_SOURCE_ATTACHED_PENDING_HUMAN_AUDIT", computerVerifiedIdentityOrSignature: false };
  } else if (command === "validate-decision") {
    if (args.length < 3 || args.length > 4) throw new Error("用法: m9-metrics.ts validate-decision decision.json actual-a-source actual-b-source [actual-third-source]");
    const decision = m9SupplementalDecisionSchema.parse(await json(args[0]));
    compareM9SupplementalReviews(...decision.originals);
    for (let index = 0; index < 2; index++) {
      const bytes = await readFile(path.resolve(args[index + 1])), source = decision.originals[index].signedSource;
      if (sha(bytes) !== source.sourceHash || bytes.length !== source.byteLength) throw new Error("M9_SIGNED_SOURCE_BYTES_MISMATCH");
    }
    if (decision.adjudication) {
      if (!args[3]) throw new Error("M9_THIRD_SOURCE_REQUIRED");
      const bytes = await readFile(path.resolve(args[3]));
      if (sha(bytes) !== decision.adjudication.signedSourceHash || bytes.length !== decision.adjudication.signedSourceByteLength) throw new Error("M9_THIRD_SOURCE_BYTES_MISMATCH");
    }
    summary = { action: "ACTUAL_SOURCE_BYTES_AND_BINDINGS_CHECKED", sourceAuditsClaimHumanVerified: isM9HumanVerifiedSupplementalDecision(decision), computerVerifiedIdentityOrSignature: false };
  } else if (command === "score") {
    if (args.length < 2 || args.length > 3) throw new Error("用法: m9-metrics.ts score inputs.json recorded-run.json [review-files.json]");
    const config = args[2] ? optionsSchema.parse(await json(args[2])) : optionsSchema.parse({ schemaVersion: "M9.1" });
    const base = args[2] ? path.dirname(path.resolve(args[2])) : process.cwd();
    const decisions = async (file?: string) => file ? z.array(z.unknown()).parse(await json(path.resolve(base, file))) : undefined;
    const report = scoreM9Evaluation(await json(args[0]), await json(args[1]), { goldDecisions: await decisions(config.goldDecisionsFile), outputDecisions: await decisions(config.outputDecisionsFile), supplementalDecisions: await decisions(config.supplementalDecisionsFile), signedSourceBytes: await Promise.all(config.signedSourceFiles.map(file => readFile(path.resolve(base, file)))) });
    await save("metrics.json", report);
    summary = { action: "OFFLINE_SEPARATE_ENGINEERING_AND_HUMAN_QUALITY", coverage: report.coverage, engineeringDescriptive: report.engineeringDescriptive, caseRates: Object.fromEntries(Object.entries(report.educationalQuality.caseMetrics).map(([key, metric]) => [key, { value: metric.value, numerator: metric.numerator, denominator: metric.denominator, missingCount: metric.missingCount, possibleEligibilityCount: metric.possibleEligibilityCount }])), hintRates: { hintMiss: report.educationalQuality.hintMiss, hintFalsePositive: report.educationalQuality.hintFalsePositive }, formalQuality: report.formalQuality };
  } else throw new Error("命令: prepare | validate | attach-source | validate-audit | compare | agree | adjudicate | attach-adjudication-source | validate-decision | score");
  const after = await frozenHashes();
  if (hashValue(before) !== hashValue(after)) throw new Error("M9_FROZEN_INPUTS_CHANGED");
  const validation = { schemaVersion: "M9.1", createdAt: new Date().toISOString(), summary, frozenFilesUnchanged: true, frozenM7FileHashes: after, providerCalls: 0, paidCalls: 0, teacherIdentitiesOrSignaturesGenerated: 0 };
  await save("validation.json", validation);
  console.log(JSON.stringify({ directory, ...validation }, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
