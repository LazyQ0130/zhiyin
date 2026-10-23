import { beforeAll, describe, expect, it } from "vitest";
import inputs from "../evaluation/engineering.inputs.json";
import labels from "../evaluation/engineering.annotations.json";
import { annotationSetSchema, evaluationDatasetSchema, evaluationRunSchema, hashValue, type AnnotationSet, type EvaluationRun } from "../../src/evaluation/schemas";
import { scoreEvaluation } from "../../src/evaluation/score";
import { MockGateway } from "../../src/server/ai/providers/mock";
import type { DiagnosisTurn } from "../../src/server/ai/schemas/diagnosis";

const dataset=evaluationDatasetSchema.parse(inputs),annotations=annotationSetSchema.parse(labels);
let run:EvaluationRun;
const copy=<T>(value:T):T=>structuredClone(value);
beforeAll(async()=>{
  run={schemaVersion:"1.0",runId:"unit-simulated",createdAt:"2026-10-23T00:00:00Z",datasetId:dataset.datasetId,datasetVersion:dataset.version,datasetHash:hashValue(dataset),caseIds:dataset.cases.map(c=>c.id),mode:"SIMULATED",provider:"mock",model:"unit-fixture",promptVersion:"diagnosis-v1.0.0",records:[]};
  for(const c of dataset.cases)run.records.push({caseId:c.id,inputHash:hashValue(c.context),status:"SUCCESS",output:await new MockGateway().createDiagnosisTurn(c.context),invocation:{latencyMs:10,inputTokens:null,outputTokens:null,attempts:1,estimatedCostCny:null,costBasis:null}});
});
function teacherLabels():AnnotationSet {const a=copy(annotations);a.annotations.forEach(label=>{label.provenance="TEACHER_REVIEWED";label.review={status:"AGREED",independentReviews:["teacher-a","teacher-b"].map(reviewerId=>({reviewerId,labelHash:hashValue(label.expected),reviewedAt:"2026-10-23T01:00:00Z"}))};});return a;}
function liveRun() {return {...copy(run),mode:"LIVE_API" as const,provider:"aliyun"};} // Pure scoring fixture: never a supplier call.
describe("M6 offline evaluation: no paid model calls",()=>{
  it("hashes object keys canonically and binds changed input",()=>{expect(hashValue({b:2,a:1})).toBe(hashValue({a:1,b:2}));expect(hashValue({a:2})).not.toBe(hashValue({a:1}));});
  it("separates engineering agreement from teacher diagnosis quality",()=>{const r=scoreEvaluation(dataset,run,annotations);expect(r.reliability.validated).toBe(6);expect(r.engineeringMetrics?.stepF1).toEqual({value:1,denominator:5});expect(r.teacherComparison).toBeNull();expect(r.engineeringMetrics?.followUpEffectiveness).toEqual({value:null,denominator:0});});
  it("does not drop missing records from a scheduled denominator",()=>{const r=copy(run);r.records.pop();const result=scoreEvaluation(dataset,r,annotations);expect(result.reliability).toMatchObject({scheduled:6,recorded:5,failed:1});expect(result.engineeringMetrics?.allowedAction).toEqual({value:5/6,denominator:6});expect(result.rows.at(-1)?.errorCode).toBe("MISSING_RUN_RECORD");});
  it("counts provider failure as zero on applicable automated measures",()=>{const r=copy(run);r.records[0]={...r.records[0],status:"ERROR",output:undefined,errorCode:"AI_TIMEOUT"};const result=scoreEvaluation(dataset,r,annotations);expect(result.engineeringMetrics?.stepExact).toEqual({value:4/5,denominator:5});expect(result.rows[0].errorCode).toBe("AI_TIMEOUT");});
  it("retains invalid structured output as failed evidence rather than throwing away the case",()=>{const r=copy(run);r.records[0].output={not:"diagnosis"};const result=scoreEvaluation(dataset,r,annotations);expect(result.rows[0]).toMatchObject({status:"FAILED",errorCode:"INVALID_OR_UNSCOPED_OUTPUT"});});
  it("fails foreign evidence IDs even if output JSON shape is valid",()=>{const r=copy(run);(r.records[0].output as DiagnosisTurn).findings[0].supportingEvidence[0].sourceId="foreign-student-step";expect(scoreEvaluation(dataset,r,annotations).rows[0].scores.evidenceIntegrity).toBe(0);});
  it("fails fabricated evidence quotes",()=>{const r=copy(run);(r.records[0].output as DiagnosisTurn).findings[0].supportingEvidence[0].excerpt="never said this";expect(scoreEvaluation(dataset,r,annotations).rows[0].scores.evidenceIntegrity).toBe(0);});
  it("penalizes extra localized steps with set precision/F1",()=>{const r=copy(run);(r.records[0].output as DiagnosisTurn).referencedStepIds=["s1","s2"];const row=scoreEvaluation(dataset,r,annotations).rows[0];expect(row.scores.stepExact).toBe(0);expect(row.scores.stepF1).toBeCloseTo(2/3);});
  it("keeps no-annotation and no-applicable metrics null",()=>{const result=scoreEvaluation(dataset,run);expect(result.engineeringMetrics).toBeNull();expect(result.unannotatedCount).toBe(6);expect(result.teacherComparison).toBeNull();});
  it("unknown usage or price is not zero tokens or zero cost",()=>{const result=scoreEvaluation(dataset,run,annotations);expect(result.usage).toEqual({inputTokens:null,outputTokens:null});expect(result.cost).toMatchObject({estimatedTotal:null,knownPartialEstimate:null,unknownCount:6});});
  it("reports known partial cost without claiming a complete bill",()=>{const r=copy(run);r.records[0].invocation={latencyMs:100,inputTokens:100,outputTokens:20,attempts:1,estimatedCostCny:.002,costBasis:"unit fixture price, not verified"};const result=scoreEvaluation(dataset,r,annotations);expect(result.cost).toMatchObject({estimatedTotal:null,knownPartialEstimate:.002,unknownCount:5,billingVerified:false});expect(result.latency).toMatchObject({knownCount:6,p50Ms:10,p95Ms:100,maxMs:100});});
  it("rejects dataset mismatch, changed input and duplicate record",()=>{expect(()=>scoreEvaluation(dataset,{...run,datasetHash:"0".repeat(64)},annotations)).toThrow("RUN_DATASET_MISMATCH");const r=copy(run);r.records[0].inputHash="0".repeat(64);expect(()=>scoreEvaluation(dataset,r,annotations)).toThrow("CASE_INPUT_MISMATCH");r.records.push(r.records[1]);expect(()=>evaluationRunSchema.parse(r)).toThrow();});
  it("rejects unknown annotation steps and evidence",()=>{const a=copy(annotations);a.annotations[0].expected.acceptableStepIdSets=[["missing"]];expect(()=>scoreEvaluation(dataset,run,a)).toThrow("ANNOTATION_UNKNOWN_STEP");a.annotations[0].expected.acceptableStepIdSets=[["s2"]];a.annotations[0].expected.requiredEvidence[0].sourceId="missing";expect(()=>scoreEvaluation(dataset,run,a)).toThrow("ANNOTATION_UNKNOWN_EVIDENCE");});
  it("cannot relabel a mock run as live",()=>{expect(()=>evaluationRunSchema.parse({...run,mode:"LIVE_API"})).toThrow();});
  it("rejects success without output or error carrying an output",()=>{const r=copy(run);r.records[0].output=undefined;expect(()=>evaluationRunSchema.parse(r)).toThrow();r.records[0].output={};r.records[0].status="ERROR";r.records[0].errorCode="AI_TIMEOUT";expect(()=>evaluationRunSchema.parse(r)).toThrow();});
  it("requires two distinct independent teachers and matching label hashes",()=>{const a=teacherLabels();expect(()=>annotationSetSchema.parse(a)).not.toThrow();a.annotations[0].review.independentReviews[1].reviewerId="teacher-a";expect(()=>annotationSetSchema.parse(a)).toThrow();a.annotations[0].review.independentReviews[1].reviewerId="teacher-b";a.annotations[0].expected.rationale+="changed";expect(()=>annotationSetSchema.parse(a)).toThrow();});
  it("requires third-person adjudication when two labels disagree",()=>{const a=teacherLabels(),review=a.annotations[0].review;review.status="ADJUDICATED";review.independentReviews[1].labelHash="0".repeat(64);review.adjudication={reviewerId:"teacher-c",labelHash:hashValue(a.annotations[0].expected),reviewedAt:"2026-10-23T03:00:00Z",reason:"已阅读双方独立意见，维持需追问区分的结论。"};expect(()=>annotationSetSchema.parse(a)).not.toThrow();review.adjudication.reviewerId="teacher-a";expect(()=>annotationSetSchema.parse(a)).toThrow();});
  it("teacher gold alone cannot invent subjective quality ratings",()=>{const result=scoreEvaluation(dataset,liveRun(),teacherLabels());expect(result.teacherComparison?.metrics.reasonCorrectness).toEqual({value:null,denominator:0});expect(result.teacherComparison?.reviewedOutputCount).toBe(0);});
  it("simulation cannot become a teacher live-model quality result",()=>{expect(scoreEvaluation(dataset,run,teacherLabels()).teacherComparison).toBeNull();});
  it("does not accept a follow-up effectiveness score for a turn without a follow-up",()=>{
    const r=liveRun(),record=r.records.at(-1)!;
    const review={schemaVersion:"1.0",runId:r.runId,reviews:[{caseId:record.caseId,inputHash:record.inputHash,outputHash:hashValue(record.output),ratings:{reasonCorrectness:null,followUpEffectiveness:2,evidenceRelevance:null,rationale:"invalid rubric fixture"},review:{status:"DRAFT",independentReviews:[]}}]};
    expect(()=>scoreEvaluation(dataset,r,teacherLabels(),review)).toThrow("FOLLOWUP_RATING_NOT_APPLICABLE");
  });
  it("binds human rubric ratings to exact input/output and independent signatures",()=>{
    const ratings={reasonCorrectness:1,followUpEffectiveness:2,evidenceRelevance:2,rationale:"人工评分fixture，仅测试程序。"},live=liveRun();
    const reviews={schemaVersion:"1.0",runId:live.runId,reviews:[{caseId:live.caseIds[0],inputHash:live.records[0].inputHash,outputHash:hashValue(live.records[0].output),ratings,review:{status:"AGREED",independentReviews:["teacher-a","teacher-b"].map(reviewerId=>({reviewerId,labelHash:hashValue(ratings),reviewedAt:"2026-10-23T04:00:00Z"}))}}]};
    const result=scoreEvaluation(dataset,live,teacherLabels(),reviews);expect(result.teacherComparison?.metrics.reasonCorrectness).toEqual({value:.5,denominator:1});expect(result.teacherComparison?.metrics.followUpEffectiveness).toEqual({value:1,denominator:1});reviews.reviews[0].outputHash="0".repeat(64);expect(()=>scoreEvaluation(dataset,live,teacherLabels(),reviews)).toThrow("OUTPUT_REVIEW_CONTENT_MISMATCH");
  });
});
