import { z } from 'zod';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import { aliyunEndpoint } from '../server/ai/configuration';

/** Operator-owned one-use permission. Never create an approved permission automatically. */
export const livePermitSchema=z.strictObject({
  schemaVersion:z.literal('1.0'),authorizationId:z.uuid(),approved:z.literal(true),approvedBy:z.string().min(1),
  issuedAt:z.iso.datetime(),expiresAt:z.iso.datetime(),
  datasetHash:z.string().regex(/^[a-f0-9]{64}$/),caseIds:z.array(z.string().min(1)).min(1).max(3),
  model:z.literal('qwen3.8-flash'),baseUrl:z.string().url(),
  maxRequests:z.number().int().min(1).max(3),maxSpendCny:z.number().positive().max(10),
  maxCompletionTokens:z.number().int().min(128).max(2500),maxRequestBytes:z.number().int().min(512).max(200000),
  pricing:z.strictObject({currency:z.literal('CNY'),inputPerMillion:z.number().positive(),outputPerMillion:z.number().positive(),source:z.string().url(),verifiedAt:z.iso.datetime(),region:z.string().min(1)}),
});
export type LivePermit=z.infer<typeof livePermitSchema>;
// Verified model maximum input length, not a tokenizer approximation; no cache discounts assumed.
export const QWEN_MAX_INPUT_TOKENS=991808;
export function reservedCostCny(permit:LivePermit):number {
  // Official completion limit may differ by <=10 tokens. Reserve for that as well.
  return (QWEN_MAX_INPUT_TOKENS*permit.pricing.inputPerMillion+(permit.maxCompletionTokens+10)*permit.pricing.outputPerMillion)/1_000_000;
}
export function authorizeLive(value:unknown,datasetHash:string,caseIds:string[],now=new Date()):LivePermit {
  const permit=livePermitSchema.parse(value);
  const issued=Date.parse(permit.issuedAt),expires=Date.parse(permit.expiresAt);
  if(issued>now.getTime()||expires<=now.getTime()||expires-issued>86400000)throw new Error('PERMIT_EXPIRED_OR_INVALID_WINDOW');
  if(now.getTime()-Date.parse(permit.pricing.verifiedAt)>7*86400000||Date.parse(permit.pricing.verifiedAt)>now.getTime())throw new Error('PRICING_NOT_RECENTLY_VERIFIED');
  const priceSource=new URL(permit.pricing.source);
  if(priceSource.protocol!=='https:'||priceSource.hostname!=='help.aliyun.com')throw new Error('OFFICIAL_PRICE_SOURCE_REQUIRED');
  aliyunEndpoint(permit.baseUrl);
  const host=new URL(permit.baseUrl).hostname;
  const region=host==='dashscope.aliyuncs.com'?'cn-beijing':host==='dashscope-intl.aliyuncs.com'?'ap-southeast-1':host==='dashscope-us.aliyuncs.com'?'us-east-1':host.split('.').slice(1,2)[0];
  if(region!==permit.pricing.region)throw new Error('PRICE_REGION_MISMATCH');
  if(!['cn-beijing','ap-southeast-1','us-east-1','eu-central-1','ap-northeast-1'].includes(region))throw new Error('REGION_PRICE_NOT_VERIFIED');
  // Non-Beijing uses the higher documented rate, also covering US deployment-scope ambiguity.
  const priceFloor=region==='cn-beijing'?{input:0.8,output:2.7}:{input:1.094,output:3.427};
  if(permit.pricing.inputPerMillion<priceFloor.input||permit.pricing.outputPerMillion<priceFloor.output)throw new Error('PRICE_BELOW_VERIFIED_UNDISCOUNTED_RATE');
  if(permit.datasetHash!==datasetHash||JSON.stringify(permit.caseIds)!==JSON.stringify(caseIds)||new Set(caseIds).size!==caseIds.length)throw new Error('PERMIT_DATASET_OR_SELECTION_MISMATCH');
  if(caseIds.length>permit.maxRequests)throw new Error('PERMIT_REQUEST_LIMIT');
  if(reservedCostCny(permit)*caseIds.length>permit.maxSpendCny)throw new Error('PERMIT_BUDGET_TOO_LOW');
  return permit;
}
export function estimateCostCny(inputTokens:number|null,outputTokens:number|null,permit:LivePermit):number|null {
  if(inputTokens===null||outputTokens===null)return null;
  return (inputTokens*permit.pricing.inputPerMillion+outputTokens*permit.pricing.outputPerMillion)/1_000_000;
}
export function consumeLivePermit(permit:LivePermit,runId:string,ledgerDirectory:string):void {
  mkdirSync(ledgerDirectory,{recursive:true});
  writeFileSync(path.join(ledgerDirectory,`${permit.authorizationId}.json`),JSON.stringify({runId,consumedAt:new Date().toISOString(),reservedCny:reservedCostCny(permit)*permit.caseIds.length}),{flag:'wx'});
}
export function guardLiveRequest(url: string, init:RequestInit|undefined,permit:LivePermit,requests:number,now=new Date()):void {
  if(Date.parse(permit.issuedAt)>now.getTime()||Date.parse(permit.expiresAt)<=now.getTime())throw new Error('PERMIT_EXPIRED_AT_REQUEST_BOUNDARY');
  if(url!==aliyunEndpoint(permit.baseUrl)||init?.method!=='POST'||init.redirect!=='error'||requests>=permit.maxRequests)throw new Error('REQUEST_OUTSIDE_PERMISSION');
  if(typeof init.body!=='string'||Buffer.byteLength(init.body,'utf8')>permit.maxRequestBytes)throw new Error('REQUEST_SIZE_LIMIT');
  const body=JSON.parse(init.body);
  if(body.model!==permit.model||body.max_completion_tokens!==permit.maxCompletionTokens||body.enable_thinking!==false||body.stream!==false||body.response_format?.type!=='json_object')throw new Error('REQUEST_PARAMETERS_OUTSIDE_PERMISSION');
}
