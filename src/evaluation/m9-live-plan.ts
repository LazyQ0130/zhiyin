import {z} from 'zod';
import {conversationCaseInputHash,conversationDatasetSchema} from './conversation-schemas';
import {hashValue} from './schemas';
import {DIAGNOSIS_PROMPT_VERSION} from '../server/ai/prompts/diagnosis-v1';

export const M9_PLANNED_CASE_IDS=['m7-d04','m7-d16','m7-d23'] as const;
export const M9_RULE_FILES=['src/server/ai/prompts/diagnosis-v1.ts','src/server/ai/validate-turn.ts','src/server/ai/evidence-trust.ts','src/server/domain/math-evidence.ts','src/server/domain/assistance-review.ts'] as const;
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const sourceHashesSchema=z.record(z.string(),sha).refine(v=>Object.keys(v).length===M9_RULE_FILES.length&&M9_RULE_FILES.every(file=>file in v),'EXACT_RULE_SOURCE_HASHES_REQUIRED');
const planSchema=z.strictObject({
  schemaVersion:z.literal('M9.PLAN.1'),status:z.literal('PLAN_ONLY'),createdAt:z.iso.datetime(),
  authorization:z.literal('NOT_GRANTED'),teacherReview:z.literal('PENDING'),executor:z.literal('LIVE_MULTI_TURN_NOT_IMPLEMENTED'),
  dataset:z.strictObject({datasetId:z.string(),version:z.string(),hash:sha,provenance:z.literal('AUTHOR_CREATED_PROVISIONAL'),
    cases:z.array(z.strictObject({caseId:z.string(),inputHash:sha,reviewStatus:z.literal('PROVISIONAL'),split:z.literal('DEV')})).length(3)}),
  model:z.literal('qwen3.8-flash'),baseUrl:z.literal('https://dashscope.aliyuncs.com/compatible-mode/v1'),region:z.literal('cn-beijing'),
  promptVersion:z.literal(DIAGNOSIS_PROMPT_VERSION),trustPolicyVersion:z.literal('M8.1'),sourceHashes:sourceHashesSchema,
  limits:z.strictObject({sessions:z.literal(3),maxTurnsPerSession:z.literal(3),maxNetworkRequests:z.literal(9),maxRetries:z.literal(0),concurrency:z.literal(1),maxCompletionTokens:z.literal(2500),maxRequestBytes:z.literal(200000),timeoutMs:z.literal(25000),proposedSpendCeilingCny:z.literal(8)}),
  pricing:z.strictObject({source:z.literal('https://help.aliyun.com/zh/model-studio/qwen3-8-flash'),verifiedAt:z.iso.datetime(),currency:z.literal('CNY'),inputPerMillion:z.literal(0.8),outputPerMillion:z.literal(2.7),maximumModelInputTokens:z.literal(991808),completionToleranceTokens:z.literal(10),discountAssumed:z.literal(false)}),
  responsePolicy:z.strictObject({stream:z.literal(false),enableThinking:z.literal(false),responseFormat:z.literal('json_object'),acceptedFinishReason:z.literal('stop'),mockFallback:z.literal(false),unknownUsage:z.literal('STOP_AND_KEEP_RESERVED_COST'),studentReply:z.literal('PAUSE_FOR_HUMAN_ALIGNMENT_APPROVAL'),rawOutput:z.literal('PRIVATE_LOCAL_ONLY'),priorPermitsReusable:z.literal(false)}),
});
export const m9LivePlanSchema=z.strictObject({plan:planSchema,planHash:sha}).superRefine((v,c)=>{if(hashValue(v.plan)!==v.planHash)c.addIssue({code:'custom',message:'PLAN_HASH_MISMATCH'});});
export type M9LivePlan=z.infer<typeof m9LivePlanSchema>;

/** A reviewable proposal, deliberately incompatible with any executable permit. */
export function buildM9LivePlan(datasetValue:unknown,sourceHashes:Record<string,string>,verifiedAt:string,now=new Date()):M9LivePlan{
  const dataset=conversationDatasetSchema.parse(datasetValue);
  if(dataset.provenance!=='AUTHOR_CREATED_PROVISIONAL')throw new Error('PLAN_REQUIRES_FROZEN_PROVISIONAL_PARENT_REBIND_AFTER_TEACHER_REVIEW');
  const cases=M9_PLANNED_CASE_IDS.map(caseId=>{
    const sample=dataset.cases.find(c=>c.id===caseId);
    if(!sample||sample.split!=='DEBUG'||sample.reviewStatus!=='PROVISIONAL')throw new Error('DEV_PROVISIONAL_SELECTION_REQUIRED');
    return {caseId,inputHash:conversationCaseInputHash(sample),reviewStatus:'PROVISIONAL' as const,split:'DEV' as const};
  });
  const plan=planSchema.parse({schemaVersion:'M9.PLAN.1',status:'PLAN_ONLY',createdAt:now.toISOString(),authorization:'NOT_GRANTED',teacherReview:'PENDING',executor:'LIVE_MULTI_TURN_NOT_IMPLEMENTED',
    dataset:{datasetId:dataset.datasetId,version:dataset.version,hash:hashValue(dataset),provenance:dataset.provenance,cases},model:'qwen3.8-flash',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',region:'cn-beijing',promptVersion:DIAGNOSIS_PROMPT_VERSION,trustPolicyVersion:'M8.1',sourceHashes,
    limits:{sessions:3,maxTurnsPerSession:3,maxNetworkRequests:9,maxRetries:0,concurrency:1,maxCompletionTokens:2500,maxRequestBytes:200000,timeoutMs:25000,proposedSpendCeilingCny:8},
    pricing:{source:'https://help.aliyun.com/zh/model-studio/qwen3-8-flash',verifiedAt,currency:'CNY',inputPerMillion:0.8,outputPerMillion:2.7,maximumModelInputTokens:991808,completionToleranceTokens:10,discountAssumed:false},
    responsePolicy:{stream:false,enableThinking:false,responseFormat:'json_object',acceptedFinishReason:'stop',mockFallback:false,unknownUsage:'STOP_AND_KEEP_RESERVED_COST',studentReply:'PAUSE_FOR_HUMAN_ALIGNMENT_APPROVAL',rawOutput:'PRIVATE_LOCAL_ONLY',priorPermitsReusable:false}});
  return m9LivePlanSchema.parse({plan,planHash:hashValue(plan)});
}

export function checkM9LivePlan(value:unknown,datasetValue:unknown,currentSourceHashes:Record<string,string>,now=new Date()){
  const envelope=m9LivePlanSchema.parse(value),{plan}=envelope,dataset=conversationDatasetSchema.parse(datasetValue);
  if(hashValue(dataset)!==plan.dataset.hash||dataset.datasetId!==plan.dataset.datasetId||dataset.version!==plan.dataset.version)throw new Error('PLAN_DATASET_CHANGED');
  if(hashValue(sourceHashesSchema.parse(currentSourceHashes))!==hashValue(plan.sourceHashes))throw new Error('PLAN_RULE_SOURCES_CHANGED');
  if(JSON.stringify(plan.dataset.cases.map(c=>c.caseId))!==JSON.stringify(M9_PLANNED_CASE_IDS))throw new Error('PLAN_SELECTION_CHANGED');
  for(const row of plan.dataset.cases){const sample=dataset.cases.find(c=>c.id===row.caseId);if(!sample||sample.split!=='DEBUG'||sample.reviewStatus!=='PROVISIONAL'||conversationCaseInputHash(sample)!==row.inputHash)throw new Error('PLAN_CASE_BINDING_CHANGED');}
  const priceAge=now.getTime()-Date.parse(plan.pricing.verifiedAt);
  const priceRecent=priceAge>=0&&priceAge<=7*86400000;
  const upperPerRequest=(plan.pricing.maximumModelInputTokens*plan.pricing.inputPerMillion+(plan.limits.maxCompletionTokens+plan.pricing.completionToleranceTokens)*plan.pricing.outputPerMillion)/1e6;
  const reservedUpperBoundCny=upperPerRequest*plan.limits.maxNetworkRequests;
  const illustrativeEstimateCny=(12000*plan.pricing.inputPerMillion+2510*plan.pricing.outputPerMillion)*9/1e6;
  return {status:'NOT_READY' as const,planHash:envelope.planHash,networkRequests:0,newActualCostCny:0,teacherReviewedCases:0,proposedSessions:plan.limits.sessions,maximumNetworkRequests:plan.limits.maxNetworkRequests,
    budget:{proposedCeilingCny:8,reservedUpperBoundCny,upperPerRequestCny:upperPerRequest,withinProposedCeiling:reservedUpperBoundCny<=8,illustrativeEstimateCny,illustrativeAssumption:'12000 input tokens per request, not a measured or enforced token bound',invoiceCostCny:null},
    blockers:['REAL_DUAL_TEACHER_REVIEW_AND_ADJUDICATION_PENDING','NEW_DATASET_VERSION_AND_INPUT_REBIND_REQUIRED','NEW_EXPLICIT_AUTHORIZATION_AND_ONE_USE_LEDGER_REQUIRED','LIVE_MULTI_TURN_EXECUTOR_NOT_IMPLEMENTED','HUMAN_REPLY_ALIGNMENT_APPROVAL_NOT_RECEIVED',...(!priceRecent?['OFFICIAL_PRICE_RECHECK_REQUIRED']:[])],
    limitation:'Preparation only. Existing single-turn permit cannot authorize nine requests; no execution entry is added.'};
}
