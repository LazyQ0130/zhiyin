import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashValue } from "../../src/evaluation/schemas";
import { buildM8TeacherPackets, compareM8IndependentReviews, createM8AdjudicationDraft, createM8AgreementDecision, isM8HumanVerifiedDecision, m8AdjudicationPayload, renderM8TeacherPacket, validateM8TeacherForm } from "../../src/evaluation/m8-teacher";
import { m8ReviewDecisionSchema, m8SignedSourceArtifactSchema } from "../../src/evaluation/m8-teacher-schemas";
import { scoreM8Evaluation } from "../../src/evaluation/m8-metrics";

// Offline only. New UUID output directories and exclusive writes retain history.
// No gateway import, network request, deletion, invented teacher or signature.
const defaultDataset = "tests/evaluation/m7/math-candidates.inputs.json";
const frozenDirectory = path.resolve("tests/evaluation/m7");
async function json(file: string): Promise<unknown> { return JSON.parse(await readFile(path.resolve(file), "utf8")); }
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function frozenHashes() {
  const manifestBytes = await readFile(path.join(frozenDirectory, "hashmanifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as { fileHashes: Record<string, string> };
  const hashes: Record<string, string> = { "hashmanifest.json": sha256(manifestBytes) };
  for (const [name, expected] of Object.entries(manifest.fileHashes)) {
    if (path.basename(name) !== name) throw new Error("M8_INVALID_MANIFEST_PATH");
    const actual = sha256(await readFile(path.join(frozenDirectory, name)));
    if (actual !== expected) throw new Error(`M8_FROZEN_FILE_MISMATCH:${name}`);
    hashes[name] = actual;
  }
  return hashes;
}
async function main() {
  const [command = "prepare", ...args] = process.argv.slice(2);
  const before = await frozenHashes();
  const directory = path.resolve(".local/m8-teacher", `${command}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  async function save(name: string, value: unknown) { await writeFile(path.join(directory, name), typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); }
  let summary: unknown;
  if (command === "prepare") {
    if (args.length > 2) throw new Error("用法: m8-teacher.ts prepare [inputs.json] [recorded-run.json]");
    const datasetValue = await json(args[0] ?? defaultDataset);
    const packets = buildM8TeacherPackets(datasetValue, args[1] ? await json(args[1]) : undefined);
    for (const slot of ["A", "B"] as const) {
      await mkdir(path.join(directory, `teacher-${slot.toLowerCase()}`));
      await save(`teacher-${slot.toLowerCase()}/packet.json`, packets[slot].packet);
      await save(`teacher-${slot.toLowerCase()}/packet.md`, renderM8TeacherPacket(packets[slot].packet));
      await save(`teacher-${slot.toLowerCase()}/review.form.json`, packets[slot].form);
      validateM8TeacherForm(packets[slot].packet, packets[slot].form);
    }
    const dataset = datasetValue as { cases: { id: string; split: "DEBUG" | "BLIND" }[] };
    await save("administrator-cohorts.json", { status: "PROVISIONAL", originalSplitMapping: { DEBUG: "DEV", BLIND: "BLIND" }, DEV: dataset.cases.filter(row => row.split === "DEBUG").map(row => row.id), BLIND: dataset.cases.filter(row => row.split === "BLIND").map(row => row.id) });
    summary = { status: "PASS", action: "GENERATED_BLANK_INDEPENDENT_PACKETS", reviewKind: packets.A.packet.reviewKind, caseCountPerReviewer: packets.A.packet.cases.length, teacherReviewedCount: 0, actualSignaturesGenerated: 0, sourceAuditState: "DRAFT_UNSIGNED" };
  } else if (command === "validate") {
    if (args.length !== 2) throw new Error("用法: m8-teacher.ts validate packet.json review.form.json");
    const { form } = validateM8TeacherForm(await json(args[0]), await json(args[1]));
    summary = { status: "PASS", action: "SCHEMA_BINDING_AND_EVIDENCE_POSITIONS_ONLY", formState: form.status, caseCount: form.cases.length, teacherIdentityOrSignatureVerified: false };
  } else if (command === "attach-source") {
    if (args.length !== 3) throw new Error("用法: m8-teacher.ts attach-source packet.json submitted.form.json actual-signed-source-file");
    const { packet, form } = validateM8TeacherForm(await json(args[0]), await json(args[1]));
    if (form.status !== "SUBMITTED") throw new Error("M8_ATTACH_REQUIRES_ACTUAL_SUBMITTED_FORM");
    const source = await readFile(path.resolve(args[2]));
    const artifact = m8SignedSourceArtifactSchema.parse({ schemaVersion: "M8.1", packet, submission: form, submissionHash: hashValue(form), signedSource: { sourceHash: sha256(source), byteLength: source.length, mediaType: "application/octet-stream" }, humanAudit: { state: "PENDING_HUMAN_AUDIT", verifierPseudonym: null, verifiedAt: null, boundSubmissionHash: null, actualTeacherAndSignatureConfirmed: false, auditNote: "" } });
    await writeFile(path.join(directory, "original-signed-source.bin"), source, { flag: "wx" });
    await save("source-audit.json", artifact);
    summary = { status: "PASS", action: "SOURCE_BYTES_ATTACHED", sourceHash: artifact.signedSource.sourceHash, sourceAuditState: "PENDING_HUMAN_AUDIT", teacherIdentityOrSignatureVerified: false };
  } else if (command === "validate-audit") {
    if (args.length !== 2) throw new Error("用法: m8-teacher.ts validate-audit source-audit.json original-signed-source-file");
    const artifact = m8SignedSourceArtifactSchema.parse(await json(args[0]));
    validateM8TeacherForm(artifact.packet, artifact.submission);
    const source = await readFile(path.resolve(args[1]));
    if (sha256(source) !== artifact.signedSource.sourceHash || source.length !== artifact.signedSource.byteLength) throw new Error("M8_SIGNED_SOURCE_BYTES_MISMATCH");
    summary = { status: "PASS", action: "SOURCE_BYTES_AND_BINDINGS_MATCH", sourceAuditState: artifact.humanAudit.state, humanVerificationClaimOnly: true, computerVerifiedSignature: false };
  } else if (command === "compare") {
    if (args.length !== 2) throw new Error("用法: m8-teacher.ts compare teacher-a.source-audit.json teacher-b.source-audit.json");
    const rows = compareM8IndependentReviews(await json(args[0]), await json(args[1]));
    await save("originals-and-disagreements.json", rows);
    summary = { status: "PASS", action: "ORIGINAL_OPINIONS_PRESERVED", caseCount: rows.length, disagreementCount: rows.filter(row => !row.agrees).length, teacherReviewedCount: 0 };
  } else if (command === "adjudicate") {
    if (args.length !== 5) throw new Error("用法: m8-teacher.ts adjudicate audit-a.json audit-b.json caseId actual-third-pseudonym reason");
    const draft = createM8AdjudicationDraft(await json(args[0]), await json(args[1]), args[2], args[3], args[4]);
    await save("adjudication.draft.json", draft);
    summary = { status: "PASS", action: "DRAFT_ONLY", state: draft.state, actualSignaturesGenerated: 0, teacherReviewedCount: 0 };
  } else if (command === "agree") {
    if (args.length !== 3) throw new Error("用法: m8-teacher.ts agree human-audited-a.json human-audited-b.json caseId");
    const decision = createM8AgreementDecision(await json(args[0]), await json(args[1]), args[2]);
    await save("agreement.decision.json", decision);
    summary = { status: "PASS", action: "AGREEMENT_FROM_EXISTING_HUMAN_AUDITS", actualSignaturesGenerated: 0, humanVerificationClaimOnly: true };
  } else if (command === "attach-adjudication-source") {
    if (args.length !== 2) throw new Error("用法: m8-teacher.ts attach-adjudication-source filled-adjudication.json actual-third-signed-source");
    const decision = m8ReviewDecisionSchema.parse(await json(args[0]));
    if (!decision.final || !decision.adjudication?.reviewedAt) throw new Error("M8_ADJUDICATION_REQUIRES_ACTUAL_FINAL_AND_REVIEW_TIME");
    const source = await readFile(path.resolve(args[1]));
    decision.state = "DRAFT_ADJUDICATION";
    Object.assign(decision.adjudication, { signedSourceHash: sha256(source), signedSourceByteLength: source.length, signature: "", humanAudit: "PENDING_HUMAN_AUDIT", verifierPseudonym: null, verifiedAt: null, actualTeacherAndSignatureConfirmed: false, adjudicationPayloadHash: hashValue(m8AdjudicationPayload(decision)) });
    await writeFile(path.join(directory, "third-original-signed-source.bin"), source, { flag: "wx" });
    await save("adjudication.source-audit.json", decision);
    summary = { status: "PASS", action: "THIRD_SOURCE_BYTES_ATTACHED", sourceAuditState: "PENDING_HUMAN_AUDIT", actualSignaturesGenerated: 0 };
  } else if (command === "validate-decision") {
    if (args.length < 3 || args.length > 4) throw new Error("用法: m8-teacher.ts validate-decision decision.json actual-a-signed-source actual-b-signed-source [actual-third-signed-source]");
    const decision = m8ReviewDecisionSchema.parse(await json(args[0]));
    compareM8IndependentReviews(...decision.originals);
    for (let index = 0; index < 2; index++) {
      const bytes = await readFile(path.resolve(args[index + 1]));
      if (sha256(bytes) !== decision.originals[index].signedSource.sourceHash || bytes.length !== decision.originals[index].signedSource.byteLength) throw new Error("M8_SIGNED_SOURCE_BYTES_MISMATCH");
    }
    if (decision.adjudication) {
      if (!args[3]) throw new Error("M8_THIRD_SIGNED_SOURCE_REQUIRED");
      const bytes = await readFile(path.resolve(args[3]));
      if (sha256(bytes) !== decision.adjudication.signedSourceHash || bytes.length !== decision.adjudication.signedSourceByteLength) throw new Error("M8_THIRD_SIGNED_SOURCE_BYTES_MISMATCH");
    }
    summary = { status: "PASS", action: "ACTUAL_SOURCE_BYTES_AND_DECISION_BINDINGS_CHECKED", sourceAuditsClaimHumanVerified: isM8HumanVerifiedDecision(decision), computerVerifiedSignature: false };
  } else if (command === "score") {
    if (args.length < 2 || args.length > 4) throw new Error("用法: m8-teacher.ts score inputs.json recorded-run.json [gold-decisions.json] [output-decisions.json]");
    const report = scoreM8Evaluation(await json(args[0]), await json(args[1]), { goldDecisions: args[2] ? await json(args[2]) as unknown[] : undefined, outputDecisions: args[3] ? await json(args[3]) as unknown[] : undefined });
    await save("metrics.json", report);
    summary = { status: "PASS", action: "ENGINEERING_AND_HUMAN_SEMANTICS_SEPARATE", coverage: report.coverage, formalQuality: report.formalQuality };
  } else throw new Error("命令: prepare | validate | attach-source | validate-audit | compare | agree | adjudicate | attach-adjudication-source | validate-decision | score");
  const after = await frozenHashes();
  if (hashValue(before) !== hashValue(after)) throw new Error("M8_FROZEN_INPUTS_CHANGED_DURING_COMMAND");
  const validation = { schemaVersion: "M8.1", createdAt: new Date().toISOString(), summary, frozenM7FileHashes: after, frozenFilesUnchanged: true, providerCalls: 0, paidCalls: 0, formalQualityGeneratedFromBlankForms: false };
  await save("validation.json", validation);
  console.log(JSON.stringify({ directory, ...validation }, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
