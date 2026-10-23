import { deterministicToolResults, validateDiagnosisTurn } from "../server/ai/validate-turn";
import type { DiagnosisTurn } from "../server/ai/schemas/diagnosis";
import { annotationSetSchema, evaluationDatasetSchema, evaluationRunSchema, hashValue, isApprovedReview, outputReviewSetSchema } from "./schemas";

export type Metric = {value:number|null; denominator:number};
const metricNames=["stepExact","stepF1","categoryExact","categoryF1","allowedAction","evidenceIntegrity","requiredEvidenceRecall","abstention","noFabricatedError","reasonCorrectness","followUpEffectiveness","evidenceRelevance"] as const;
type MetricName=typeof metricNames[number];
type Scores=Record<MetricName,number|null>;
function setScore(actual:string[],expected:string[]) {
  const a=new Set(actual),b=new Set(expected),overlap=[...a].filter(s=>b.has(s)).length;
  if(!a.size&&!b.size)return {exact:1,f1:1};
  return {exact:Number(a.size===b.size&&overlap===b.size),f1:2*overlap/(a.size+b.size)};
}
function bestSet(actual:string[],sets:string[][]) { return sets.map(s=>setScore(actual,s)).sort((a,b)=>b.f1-a.f1)[0]; }
function average(scores:Array<number|null>):Metric {const values=scores.filter((v):v is number=>v!==null);return {value:values.length?values.reduce((a,b)=>a+b,0)/values.length:null,denominator:values.length};}
function percentile(values:number[],p:number) {return values.length?[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]:null;}

/** Offline only: gold/teacher sidecars never enter a gateway context. No model judge. */
export function scoreEvaluation(datasetValue:unknown,runValue:unknown,annotationsValue?:unknown,reviewsValue?:unknown) {
  const dataset=evaluationDatasetSchema.parse(datasetValue),run=evaluationRunSchema.parse(runValue);
  const annotations=annotationsValue===undefined?null:annotationSetSchema.parse(annotationsValue);
  const reviews=reviewsValue===undefined?null:outputReviewSetSchema.parse(reviewsValue);
  const datasetHash=hashValue(dataset);
  if(run.datasetId!==dataset.datasetId||run.datasetVersion!==dataset.version||run.datasetHash!==datasetHash)throw new Error("RUN_DATASET_MISMATCH");
  if(annotations&&(annotations.datasetId!==dataset.datasetId||annotations.datasetVersion!==dataset.version||annotations.datasetHash!==datasetHash))throw new Error("ANNOTATION_DATASET_MISMATCH");
  if(reviews&&reviews.runId!==run.runId)throw new Error("OUTPUT_REVIEW_RUN_MISMATCH");
  if(annotations?.annotations.some(a=>!dataset.cases.some(c=>c.id===a.caseId)))throw new Error("ANNOTATION_UNKNOWN_CASE");
  if(reviews?.reviews.some(r=>!run.caseIds.includes(r.caseId)))throw new Error("OUTPUT_REVIEW_UNKNOWN_CASE");
  const rows=run.caseIds.map(caseId=>{
    const sample=dataset.cases.find(c=>c.id===caseId);if(!sample)throw new Error("RUN_UNKNOWN_CASE");
    const inputHash=hashValue(sample.context),record=run.records.find(r=>r.caseId===caseId),annotation=annotations?.annotations.find(a=>a.caseId===caseId),review=reviews?.reviews.find(r=>r.caseId===caseId);
    if(record&&record.inputHash!==inputHash||annotation&&annotation.inputHash!==inputHash||review&&review.inputHash!==inputHash)throw new Error("CASE_INPUT_MISMATCH");
    let output:DiagnosisTurn|null=null,errorCode=record?.errorCode??(record?null:"MISSING_RUN_RECORD");
    if(record?.status==="SUCCESS") {try {output=validateDiagnosisTurn(record.output,sample.context);}catch {errorCode="INVALID_OR_UNSCOPED_OUTPUT";}}
    if(review&&(!output||review.outputHash!==hashValue(record?.output)))throw new Error("OUTPUT_REVIEW_CONTENT_MISMATCH");
    if(review&&output?.action!=="ASK_ONE_QUESTION"&&review.ratings.followUpEffectiveness!==null)throw new Error("FOLLOWUP_RATING_NOT_APPLICABLE");
    const s=Object.fromEntries(metricNames.map(k=>[k,null])) as Scores;
    s.evidenceIntegrity=Number(output!==null);
    const label=annotation?.expected;
    if(label) {
      if(label.acceptableStepIdSets?.some(set=>set.some(id=>!sample.context.steps.some(step=>step.id===id))))throw new Error("ANNOTATION_UNKNOWN_STEP");
      const sources={STUDENT_STEP:sample.context.steps.map(s=>s.id),STUDENT_REPLY:sample.context.messages.filter(m=>m.role==="USER").map(m=>m.id),QUESTION_TEXT:[sample.context.questionId],TOOL_RESULT:deterministicToolResults(sample.context).map(t=>t.id)};
      if(label.requiredEvidence.some(e=>!sources[e.kind].includes(e.sourceId)))throw new Error("ANNOTATION_UNKNOWN_EVIDENCE");
      if(label.acceptableStepIdSets) {const score=output?bestSet(output.referencedStepIds,label.acceptableStepIdSets):{exact:0,f1:0};s.stepExact=score.exact;s.stepF1=score.f1;}
      if(label.acceptableCategorySets) {const score=output?bestSet(output.findings.filter(f=>!["REFUTED","UNRESOLVED"].includes(f.status)).map(f=>f.category),label.acceptableCategorySets):{exact:0,f1:0};s.categoryExact=score.exact;s.categoryF1=score.f1;}
      s.allowedAction=Number(Boolean(output&&label.allowedActions.includes(output.action)));
      if(label.requiresAbstention!==null)s.abstention=Number(Boolean(output&&(label.requiresAbstention?(output.action==="MARK_INCONCLUSIVE"||output.action==="REQUEST_INPUT_CORRECTION")&&output.findings.every(f=>!["SUPPORTED","VERIFIED"].includes(f.status)):!["MARK_INCONCLUSIVE","REQUEST_INPUT_CORRECTION"].includes(output.action))));
      if(label.noErrorExpected)s.noFabricatedError=Number(Boolean(output&&output.findings.every(f=>f.status==="REFUTED"||f.category==="UNDETERMINED")));
      if(label.requiredEvidence.length) {
        const actual=output?new Set(output.findings.flatMap(f=>[...f.supportingEvidence,...f.contradictingEvidence]).map(e=>`${e.kind}:${e.sourceId}`)):new Set();
        s.requiredEvidenceRecall=label.requiredEvidence.filter(e=>actual.has(`${e.kind}:${e.sourceId}`)).length/label.requiredEvidence.length;
      }
    }
    const teacherGold=annotation?.provenance==="TEACHER_REVIEWED"&&isApprovedReview(annotation.review,annotation.expected);
    const reviewed=review&&isApprovedReview(review.review,review.ratings);
    if(reviewed&&teacherGold)for(const key of ["reasonCorrectness","followUpEffectiveness","evidenceRelevance"] as const)s[key]=review.ratings[key]===null?null:review.ratings[key]/2;
    return {caseId,status:output?"VALIDATED_OUTPUT":"FAILED",errorCode,annotation:annotation?.provenance??"UNANNOTATED",teacherGold:Boolean(teacherGold),outputReviewApproved:Boolean(reviewed),scores:s};
  });
  const aggregate=(selected:typeof rows)=>Object.fromEntries(metricNames.map(k=>[k,average(selected.map(r=>r.scores[k]))])) as Record<MetricName,Metric>;
  const invocations=run.records.map(r=>r.invocation),latencies=invocations.flatMap(i=>i.latencyMs===null?[]:[i.latencyMs]),knownCost=invocations.filter(i=>i.estimatedCostCny!==null);
  const teacherRows=rows.filter(r=>r.teacherGold),engineeringRows=rows.filter(r=>r.annotation==="ENGINEERING_PROVISIONAL");
  return {schemaVersion:"1.0",runId:run.runId,mode:run.mode,datasetId:dataset.datasetId,datasetHash,
    disclaimer:"工程一致性指标不等于教育诊断准确率。错因语义、追问有效性、证据相关性需教师盲审；未审核不计质量分。人工指标为已审核输出的条件均值，须连同失败率、审核覆盖率阅读。费用是估算，不是账单。",
    reliability:{scheduled:rows.length,recorded:run.records.length,validated:rows.filter(r=>r.status==="VALIDATED_OUTPUT").length,failed:rows.filter(r=>r.status==="FAILED").length},
    engineeringMetrics:engineeringRows.length?aggregate(engineeringRows):null,
    teacherComparison:run.mode==="LIVE_API"&&teacherRows.length?{caseCount:teacherRows.length,reviewedOutputCount:teacherRows.filter(r=>r.outputReviewApproved).length,metrics:aggregate(teacherRows)}:null,
    unannotatedCount:rows.filter(r=>r.annotation==="UNANNOTATED").length,
    latency:{knownCount:latencies.length,unknownCount:rows.length-latencies.length,p50Ms:percentile(latencies,.5),p95Ms:percentile(latencies,.95),maxMs:latencies.length?Math.max(...latencies):null},
    usage:{inputTokens:invocations.length===rows.length&&invocations.every(i=>i.inputTokens!==null)?invocations.reduce((s,i)=>s+(i.inputTokens??0),0):null,outputTokens:invocations.length===rows.length&&invocations.every(i=>i.outputTokens!==null)?invocations.reduce((s,i)=>s+(i.outputTokens??0),0):null},
    cost:{currency:"CNY",estimatedTotal:knownCost.length===rows.length?knownCost.reduce((s,i)=>s+(i.estimatedCostCny??0),0):null,knownPartialEstimate:knownCost.length?knownCost.reduce((s,i)=>s+(i.estimatedCostCny??0),0):null,unknownCount:rows.length-knownCost.length,billingVerified:false},
    rows,
  };
}
