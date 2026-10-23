import { createHash } from "node:crypto";
import { z } from "zod";
import { diagnosisTurnSchema, findingSchema, TAXONOMY } from "../server/ai/schemas/diagnosis";
import {parseAssistanceReview,type AssistanceReview} from '../server/domain/assistance-review';

const id = z.string().min(1).max(160);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const strings = z.array(id).max(100).refine(a => new Set(a).size === a.length, "重复标识");
export function hashValue(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v !== null && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
    return JSON.stringify(v);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export const evaluationContextSchema = z.strictObject({
  questionId: id, questionText: z.string().min(1).max(10000), subject: id, gradeBand: id,
  steps: z.array(z.strictObject({id, text:z.string().min(1).max(15000)})).max(40),
  messages: z.array(z.strictObject({id, role:z.enum(["USER", "ASSISTANT"]), content:z.string().min(1).max(4000),assistance:z.custom<AssistanceReview>(v=>parseAssistanceReview(v)!==null).transform(v=>parseAssistanceReview(v)!).optional()})).max(40),
  findings: z.array(findingSchema).max(8), turnCount:z.number().int().min(0).max(6),
  hintLevel:z.union([z.literal(0),z.literal(1),z.literal(2),z.literal(3)]), requestedAction:z.enum(["REPLY","HINT","FINISH"]).optional(),
}).superRefine((v, ctx) => {
  const ids = [v.questionId, ...v.steps.map(s=>s.id), ...v.messages.map(m=>m.id)];
  if (new Set(ids).size !== ids.length) ctx.addIssue({code:"custom",message:"上下文source ID必须唯一"});
});
export const evaluationDatasetSchema = z.strictObject({
  schemaVersion:z.literal("1.0"), datasetId:id, version:id,
  provenance:z.enum(["ENGINEERING_SYNTHETIC", "TEACHER_CURATED"]), description:z.string().min(1),
  cases:z.array(z.strictObject({id, tags:strings, source:z.strictObject({kind:z.enum(["SYNTHETIC","CONSENTED_ADULT"]),reference:z.string().min(1),license:z.string().min(1)}),context:evaluationContextSchema})).min(1).max(10000),
}).superRefine((v,ctx)=>{if(new Set(v.cases.map(c=>c.id)).size!==v.cases.length)ctx.addIssue({code:"custom",message:"重复case ID"});});

const evidenceRef = z.strictObject({kind:z.enum(["STUDENT_STEP","STUDENT_REPLY","TOOL_RESULT","QUESTION_TEXT"]),sourceId:id});
export const expectedLabelSchema = z.strictObject({
  acceptableStepIdSets:z.array(strings).min(1).nullable(),
  acceptableCategorySets:z.array(z.array(z.enum(TAXONOMY)).refine(a=>new Set(a).size===a.length)).min(1).nullable(),
  allowedActions:z.array(diagnosisTurnSchema.shape.action).min(1),
  requiresAbstention:z.boolean().nullable(), noErrorExpected:z.boolean(), requiredEvidence:z.array(evidenceRef).max(30),
  rationale:z.string().min(1).max(5000),
});
export const reviewControlSchema = z.strictObject({
  status:z.enum(["DRAFT","AGREED","ADJUDICATED"]),
  independentReviews:z.array(z.strictObject({reviewerId:id,labelHash:hash,reviewedAt:z.iso.datetime()})).max(2),
  adjudication:z.strictObject({reviewerId:id,labelHash:hash,reviewedAt:z.iso.datetime(),reason:z.string().min(1)}).optional(),
});
export function isApprovedReview(review:z.infer<typeof reviewControlSchema>, label:unknown):boolean {
  if(review.status==="DRAFT"||review.independentReviews.length!==2)return false;
  const [a,b]=review.independentReviews;
  if(a.reviewerId===b.reviewerId)return false;
  const expectedHash=hashValue(label);
  if(review.status==="AGREED")return !review.adjudication&&a.labelHash===expectedHash&&b.labelHash===expectedHash;
  return Boolean(review.adjudication&&![a.reviewerId,b.reviewerId].includes(review.adjudication.reviewerId)&&review.adjudication.labelHash===expectedHash);
}
export const annotationSetSchema = z.strictObject({
  schemaVersion:z.literal("1.0"), datasetId:id, datasetVersion:id, datasetHash:hash,
  annotations:z.array(z.strictObject({caseId:id,inputHash:hash,provenance:z.enum(["ENGINEERING_PROVISIONAL","TEACHER_REVIEWED"]),expected:expectedLabelSchema,review:reviewControlSchema})).max(10000),
}).superRefine((v,ctx)=>{
  if(new Set(v.annotations.map(a=>a.caseId)).size!==v.annotations.length)ctx.addIssue({code:"custom",message:"重复annotation"});
  v.annotations.forEach((a,i)=>{if(a.provenance==="TEACHER_REVIEWED"&&!isApprovedReview(a.review,a.expected))ctx.addIssue({code:"custom",path:["annotations",i,"review"],message:"教师金标须两位独立评审一致或第三位仲裁，并绑定最终标签hash"});});
});
export const evaluationInvocationSchema = z.strictObject({latencyMs:z.number().nonnegative().nullable(),inputTokens:z.number().int().nonnegative().nullable(),outputTokens:z.number().int().nonnegative().nullable(),attempts:z.number().int().nonnegative(),estimatedCostCny:z.number().nonnegative().nullable(),costBasis:z.string().min(1).nullable()});
export const evaluationRunSchema = z.strictObject({
  schemaVersion:z.literal("1.0"),runId:id,createdAt:z.iso.datetime(),datasetId:id,datasetVersion:id,datasetHash:hash,
  caseIds:strings.min(1),mode:z.enum(["SIMULATED","LIVE_API"]),provider:id,model:id,promptVersion:id,
  records:z.array(z.strictObject({caseId:id,inputHash:hash,status:z.enum(["SUCCESS","ERROR"]),output:z.unknown().optional(),errorCode:id.optional(),invocation:evaluationInvocationSchema})).max(10000),
}).superRefine((v,ctx)=>{
  if(v.mode==="LIVE_API"&&v.provider.toLowerCase()==="mock")ctx.addIssue({code:"custom",message:"Mock不能标为真实API测试"});
  if(new Set(v.records.map(r=>r.caseId)).size!==v.records.length)ctx.addIssue({code:"custom",message:"重复run record"});
  v.records.forEach((r,i)=>{
    if(!v.caseIds.includes(r.caseId))ctx.addIssue({code:"custom",path:["records",i],message:"record不在本次caseIds中"});
    if(r.status==="SUCCESS"&&(r.output===undefined||r.errorCode!==undefined)||r.status==="ERROR"&&(!r.errorCode||r.output!==undefined))ctx.addIssue({code:"custom",path:["records",i],message:"成功必须有output；失败必须有errorCode且不能带output"});
    if(r.invocation.estimatedCostCny!==null&&!r.invocation.costBasis)ctx.addIssue({code:"custom",path:["records",i],message:"估算费用必须注明定价依据"});
  });
});
export const qualityRatingsSchema=z.strictObject({reasonCorrectness:z.number().int().min(0).max(2).nullable(),followUpEffectiveness:z.number().int().min(0).max(2).nullable(),evidenceRelevance:z.number().int().min(0).max(2).nullable(),rationale:z.string().min(1).max(5000)});
export const outputReviewSetSchema=z.strictObject({schemaVersion:z.literal("1.0"),runId:id,reviews:z.array(z.strictObject({caseId:id,inputHash:hash,outputHash:hash,ratings:qualityRatingsSchema,review:reviewControlSchema})).max(10000)}).superRefine((v,ctx)=>{
  if(new Set(v.reviews.map(r=>r.caseId)).size!==v.reviews.length)ctx.addIssue({code:"custom",message:"重复output review"});
  v.reviews.forEach((r,i)=>{if(r.review.status!=="DRAFT"&&!isApprovedReview(r.review,r.ratings))ctx.addIssue({code:"custom",path:["reviews",i],message:"输出评分审核签收与ratings不匹配"});});
});
export type EvaluationDataset=z.infer<typeof evaluationDatasetSchema>;
export type EvaluationRun=z.infer<typeof evaluationRunSchema>;
export type AnnotationSet=z.infer<typeof annotationSetSchema>;
export type OutputReviewSet=z.infer<typeof outputReviewSetSchema>;
