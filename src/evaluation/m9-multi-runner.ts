import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import type {DiagnosisContext,ModelInvocation} from '../server/ai/gateway';
import {diagnosisTurnSchema,type DiagnosisTurn} from '../server/ai/schemas/diagnosis';
import {validateDiagnosisTurn} from '../server/ai/validate-turn';
import {advanceConversationContext,isConversationTerminal} from './conversation-score';
import {conversationCaseInputHash,conversationDatasetSchema} from './conversation-schemas';
import {evaluationContextSchema,hashValue} from './schemas';
import {authorizeM9MultiPermit,consumeM9MultiPermit,m9EstimateCostCny,m9ReservedCostCny,type M9MultiPermit} from './m9-multi-permit';

const sha=z.string().regex(/^[a-f0-9]{64}$/);
const approvalBase={schemaVersion:z.literal('M9.REPLY.1'),approved:z.literal(true),approvedBy:z.string().trim().min(1),approvedAt:z.iso.datetime(),authorizationId:z.uuid(),runId:z.uuid(),caseId:z.string().min(1),turnIndex:z.number().int().min(0),previousCheckpointHash:sha,previousGuardedOutputHash:sha};
/** Only an operator may fill this object; the runner never manufactures approval. */
export const m9MultiApprovalSchema=z.discriminatedUnion('action',[
  z.strictObject({...approvalBase,action:z.literal('REPLY'),replyId:z.string().min(1),replyContent:z.string().min(1),replyHash:sha}),
  z.strictObject({...approvalBase,action:z.literal('NEXT_CASE'),nextCaseId:z.string().min(1)}),
]);
export type M9MultiApproval=z.infer<typeof m9MultiApprovalSchema>;
export interface M9RequestBoundary {caseId:string;inputHash:string;turnIndex:number;contextHash:string;requests:number;committedSpendCny:number;reservedSpendCny:number;requestNumber:number;usageKnown:true}
export interface M9InvocationResult {rawOutput?:unknown;guardedOutput?:unknown;invocation:ModelInvocation|null;responseEvidence?:unknown;errorCode?:string;rawTruncated?:boolean;networkRequests?:0|1}
export type M9Invoke=(context:DiagnosisContext,boundary:M9RequestBoundary)=>Promise<M9InvocationResult>;
type Status='READY'|'WAITING_REPLY_APPROVAL'|'WAITING_NEXT_CASE_APPROVAL'|'COMPLETED'|'STOP_LIMIT'|'ABORTED'|'NONRESUMABLE_PENDING_CLAIM';
export interface M9Turn {
  caseId:string;turnIndex:number;context:DiagnosisContext;contextHash:string;approval?:M9MultiApproval;
  rawOutput?:unknown;rawOutputHash?:string;rawStorageHash?:string;guardedOutput?:DiagnosisTurn;guardedOutputHash?:string;guardedStorageHash?:string;
  invocation:ModelInvocation|null;responseEvidence?:unknown;errorCode?:string;estimatedCostCny:number|null;reservedSpendCny:number;rawTruncated:boolean;networkRequests:number|null;
}
export interface M9MultiState {
  runId:string;authorizationId:string;executionMode:'LIVE_API'|'SYNTHETIC_TRANSPORT';permitHash:string;datasetHash:string;caseIds:string[];
  createdAt:string;status:Status;caseIndex:number;requestCount:number;networkDispatches:number|null;committedSpendCny:number;reservedSpendCny:number;turns:M9Turn[];errorCode?:string;
}
export interface M9MultiCheckpoint {schemaVersion:'M9.CHECKPOINT.1';sequence:number;previousCheckpointHash:string|null;state:M9MultiState;checkpointHash:string}
interface Header {schemaVersion:'M9.RUN.1';runId:string;authorizationId:string;permitHash:string;datasetHash:string;ledgerDirectory:string;initialCheckpointHash:string}
export interface M9MultiRunOptions {
  permit:unknown;binding:Parameters<typeof authorizeM9MultiPermit>[1];invoke:M9Invoke;executionMode:'LIVE_API'|'SYNTHETIC_TRANSPORT';
  directory?:string;ledgerDirectory?:string;now?:Date;redactSecrets?:string[];
}
const location=(directory:string|undefined,runId:string)=>path.join(path.resolve(directory??'.local/m9-live'),z.uuid().parse(runId));
const numbered=(kind:'checkpoint'|'claim',sequence:number)=>`${kind}-${String(sequence).padStart(6,'0')}.json`;
const loadJson=(file:string):unknown=>JSON.parse(readFileSync(file,'utf8'));
const saveJson=(file:string,value:unknown)=>writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});
function checkpoint(state:M9MultiState,previous:M9MultiCheckpoint|null):M9MultiCheckpoint {
  const payload={schemaVersion:'M9.CHECKPOINT.1' as const,sequence:previous?previous.sequence+1:0,previousCheckpointHash:previous?.checkpointHash??null,state};
  return {...payload,checkpointHash:hashValue(payload)};
}
function verifyLedger(header:Header) {
  const ledger=loadJson(path.join(header.ledgerDirectory,`${header.authorizationId}.json`)) as Record<string,unknown>;
  if(ledger.schemaVersion!=='M9.MULTI.1'||ledger.authorizationId!==header.authorizationId||ledger.runId!==header.runId||ledger.permitHash!==header.permitHash)throw new Error('ORIGINAL_LEDGER_BINDING_REQUIRED');
}
/** Read every prefix, including its matching permanent operation claim. An orphan claim cannot be retried. */
export function readM9MultiRun(directory:string|undefined,runId:string):M9MultiCheckpoint {
  const folder=location(directory,runId),header=loadJson(path.join(folder,'run.json')) as Header;
  if(header.schemaVersion!=='M9.RUN.1'||header.runId!==runId)throw new Error('JOURNAL_HEADER_INVALID');
  verifyLedger(header);
  const files=readdirSync(folder),checkpoints=files.filter(f=>/^checkpoint-\d{6}\.json$/.test(f)).sort(),claims=files.filter(f=>/^claim-\d{6}\.json$/.test(f)).sort();
  if(!checkpoints.length||claims.length<checkpoints.length-1||claims.length>checkpoints.length)throw new Error('JOURNAL_PREFIX_INVALID');
  let previous:M9MultiCheckpoint|null=null;
  for(let i=0;i<checkpoints.length;i++){
    if(checkpoints[i]!==numbered('checkpoint',i))throw new Error('JOURNAL_PREFIX_INVALID');
    const current=loadJson(path.join(folder,checkpoints[i])) as M9MultiCheckpoint;
    const {checkpointHash,...payload}=current;
    if(current.schemaVersion!=='M9.CHECKPOINT.1'||current.sequence!==i||hashValue(payload)!==checkpointHash||current.previousCheckpointHash!==(previous?.checkpointHash??null))throw new Error('CHECKPOINT_HASH_OR_PREFIX_INVALID');
    const state=current.state;
    if(state.runId!==runId||state.authorizationId!==header.authorizationId||state.permitHash!==header.permitHash||state.datasetHash!==header.datasetHash||state.requestCount!==i||state.turns.length!==i)throw new Error('CHECKPOINT_STATE_INVALID');
    if(i===0&&checkpointHash!==header.initialCheckpointHash)throw new Error('INITIAL_CHECKPOINT_CHANGED');
    if(previous){
      if(hashValue(state.turns.slice(0,-1))!==hashValue(previous.state.turns)||hashValue(state.caseIds)!==hashValue(previous.state.caseIds)||state.executionMode!==previous.state.executionMode)throw new Error('CHECKPOINT_HISTORY_CHANGED');
      if(claims[i-1]!==numbered('claim',i))throw new Error('JOURNAL_CLAIM_SEQUENCE_INVALID');
      const claim=loadJson(path.join(folder,claims[i-1])) as Record<string,unknown>,turn=state.turns[i-1];
      if(claim.previousCheckpointHash!==previous.checkpointHash||claim.requestNumber!==i||claim.contextHash!==turn.contextHash||claim.caseId!==turn.caseId||claim.turnIndex!==turn.turnIndex)throw new Error('CLAIM_BINDING_INVALID');
      if(hashValue(turn.context)!==turn.contextHash||(turn.rawOutput!==undefined&&hashValue(turn.rawOutput)!==turn.rawStorageHash)||(turn.guardedOutput!==undefined&&hashValue(turn.guardedOutput)!==turn.guardedStorageHash))throw new Error('TURN_STORAGE_HASH_INVALID');
    }
    previous=current;
  }
  if(claims.length===checkpoints.length){
    if(claims.at(-1)!==numbered('claim',checkpoints.length))throw new Error('JOURNAL_CLAIM_SEQUENCE_INVALID');
    const claim=loadJson(path.join(folder,claims.at(-1)!)) as Record<string,unknown>;
    if(claim.previousCheckpointHash!==previous!.checkpointHash||claim.requestNumber!==previous!.state.requestCount+1||typeof claim.reservedSpendCny!=='number'||!Number.isFinite(claim.reservedSpendCny)||claim.reservedSpendCny<previous!.state.reservedSpendCny)throw new Error('CLAIM_BINDING_INVALID');
    return {...previous!,state:{...previous!.state,requestCount:claim.requestNumber as number,reservedSpendCny:claim.reservedSpendCny,networkDispatches:null,status:'NONRESUMABLE_PENDING_CLAIM',errorCode:'REQUEST_CLAIM_WITHOUT_RESULT'}};
  }
  return previous!;
}
function sanitize(value:unknown,secrets:string[]):unknown {
  const clean=(text:string)=>{
    for(const secret of secrets)if(secret)text=text.split(secret).join('[REDACTED]');
    return text.replace(/\bsk-(?:ws-)?[A-Za-z0-9_.-]+/g,'[REDACTED]').replace(/Bearer\s+[^\s"'\\]+/gi,'Bearer [REDACTED]');
  };
  if(typeof value==='string')return clean(value);
  if(Array.isArray(value))return value.map(item=>sanitize(item,secrets));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/^(authorization|api[-_]?key|cookie|set-cookie)$/i.test(key)?'[REDACTED]':sanitize(item,secrets)]));
  return value;
}
const safeError=(value:unknown)=>{
  const code=value&&typeof value==='object'?'code' in value?value.code:'errorCode' in value?value.errorCode:undefined:undefined;
  return typeof code==='string'&&/^(AI_(TIMEOUT|UNAVAILABLE|INVALID_OUTPUT|NOT_CONFIGURED|RATE_LIMITED)|RAW_OUTPUT_TRUNCATED)$/.test(code)?code:'INVOCATION_FAILED';
};
function binding(options:M9MultiRunOptions) {
  const permit=authorizeM9MultiPermit(options.permit,options.binding,options.now??new Date());
  const dataset=conversationDatasetSchema.parse(options.binding.dataset);
  if(options.executionMode!=='LIVE_API'&&options.executionMode!=='SYNTHETIC_TRANSPORT')throw new Error('EXECUTION_MODE_REQUIRED');
  return {permit,dataset};
}
export async function startM9MultiRun(options:M9MultiRunOptions):Promise<M9MultiCheckpoint> {
  const {permit,dataset}=binding(options),runId=randomUUID(),folder=location(options.directory,runId);
  mkdirSync(path.dirname(folder),{recursive:true});mkdirSync(folder,{mode:0o700});
  const state:M9MultiState={runId,authorizationId:permit.authorizationId,executionMode:options.executionMode,permitHash:hashValue(permit),datasetHash:hashValue(dataset),caseIds:permit.caseIds,createdAt:(options.now??new Date()).toISOString(),status:'READY',caseIndex:0,requestCount:0,networkDispatches:0,committedSpendCny:0,reservedSpendCny:0,turns:[]};
  const initial=checkpoint(state,null),ledgerDirectory=path.resolve(options.ledgerDirectory??'.local/eval-authorizations');
  saveJson(path.join(folder,'run.json'),{schemaVersion:'M9.RUN.1',runId,authorizationId:permit.authorizationId,permitHash:state.permitHash,datasetHash:state.datasetHash,ledgerDirectory,initialCheckpointHash:initial.checkpointHash});
  saveJson(path.join(folder,numbered('checkpoint',0)),initial);
  consumeM9MultiPermit(permit,runId,ledgerDirectory);
  return requestOnce(options,initial,permit,dataset.cases.find(c=>c.id===permit.caseIds[0])!.initialContext,0,0);
}
export async function resumeM9MultiRun(options:M9MultiRunOptions&{runId:string;approval:unknown}):Promise<M9MultiCheckpoint> {
  const {permit,dataset}=binding(options),previous=readM9MultiRun(options.directory,options.runId),state=previous.state;
  const header=loadJson(path.join(location(options.directory,options.runId),'run.json')) as Header;
  if(state.permitHash!==hashValue(permit)||state.datasetHash!==hashValue(dataset)||state.executionMode!==options.executionMode||(options.ledgerDirectory&&path.resolve(options.ledgerDirectory)!==header.ledgerDirectory))throw new Error('RESUME_AUTHORIZATION_BINDING_CHANGED');
  if(!['WAITING_REPLY_APPROVAL','WAITING_NEXT_CASE_APPROVAL'].includes(state.status))throw new Error('RUN_NOT_RESUMABLE:'+state.status);
  const approval=m9MultiApprovalSchema.parse(options.approval),last=state.turns.at(-1)!,sample=dataset.cases.find(c=>c.id===last.caseId)!;
  if(approval.authorizationId!==permit.authorizationId||approval.runId!==state.runId||approval.caseId!==last.caseId||approval.turnIndex!==last.turnIndex||approval.previousCheckpointHash!==previous.checkpointHash||approval.previousGuardedOutputHash!==last.guardedOutputHash)throw new Error('APPROVAL_BINDING_MISMATCH');
  if(Date.parse(approval.approvedAt)<Date.parse(state.createdAt)||Date.parse(approval.approvedAt)>(options.now??new Date()).getTime())throw new Error('APPROVAL_TIME_INVALID');
  if(state.status==='WAITING_REPLY_APPROVAL'){
    const reply=sample.studentReplies[last.turnIndex];
    if(approval.action!=='REPLY'||!reply||approval.replyId!==reply.id||approval.replyContent!==reply.content||approval.replyHash!==hashValue(reply))throw new Error('EXACT_SCRIPT_REPLY_APPROVAL_REQUIRED');
    return requestOnce(options,previous,permit,advanceConversationContext(sample,last.context,last.guardedOutput!,last.turnIndex,'M8.1'),state.caseIndex,last.turnIndex+1,approval);
  }
  const nextCaseId=permit.caseIds[state.caseIndex+1];
  if(approval.action!=='NEXT_CASE'||!nextCaseId||approval.nextCaseId!==nextCaseId)throw new Error('NEXT_CASE_APPROVAL_REQUIRED');
  return requestOnce(options,previous,permit,dataset.cases.find(c=>c.id===nextCaseId)!.initialContext,state.caseIndex+1,0,approval);
}
async function requestOnce(options:M9MultiRunOptions,previous:M9MultiCheckpoint,permit:M9MultiPermit,context:DiagnosisContext,caseIndex:number,turnIndex:number,approval?:M9MultiApproval):Promise<M9MultiCheckpoint> {
  const state=previous.state,folder=location(options.directory,state.runId),sample=conversationDatasetSchema.parse(options.binding.dataset).cases.find(c=>c.id===permit.caseIds[caseIndex])!;
  const reserve=m9ReservedCostCny(permit),secrets=options.redactSecrets??[];
  if(turnIndex>=permit.maxTurnsPerSession||state.requestCount>=permit.maxRequests||state.committedSpendCny+state.reservedSpendCny+reserve>permit.maxSpendCny)throw new Error('REQUEST_LIMIT_REACHED');
  if(hashValue(sanitize(context,secrets))!==hashValue(context))throw new Error('SECRET_MATERIAL_IN_CONTEXT');
  if(approval&&hashValue(sanitize(approval,secrets))!==hashValue(approval))throw new Error('SECRET_MATERIAL_IN_APPROVAL');
  evaluationContextSchema.parse(context);
  const boundary:M9RequestBoundary={caseId:sample.id,inputHash:conversationCaseInputHash(sample),turnIndex,contextHash:hashValue(context),requests:state.requestCount,committedSpendCny:state.committedSpendCny,reservedSpendCny:state.reservedSpendCny,requestNumber:state.requestCount+1,usageKnown:true};
  // This permanent numbered wx claim is the operation lock. A concurrent caller or crash cannot reclaim it.
  saveJson(path.join(folder,numbered('claim',boundary.requestNumber)),{schemaVersion:'M9.CLAIM.1',runId:state.runId,authorizationId:permit.authorizationId,previousCheckpointHash:previous.checkpointHash,...boundary,reservedSpendCny:state.reservedSpendCny+reserve,approvalHash:approval?hashValue(approval):null});
  let result:M9InvocationResult,timer:ReturnType<typeof setTimeout>|undefined;
  try{result=await Promise.race([options.invoke(structuredClone(context),boundary),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject({code:'AI_TIMEOUT'}),permit.timeoutMs);})]);}catch(error){result={invocation:null,errorCode:safeError(error)};}finally{if(timer)clearTimeout(timer);}
  let errorCode=result.errorCode?safeError({code:result.errorCode}):undefined,guarded:DiagnosisTurn|undefined;
  const networkRequests=result.networkRequests??(options.executionMode==='SYNTHETIC_TRANSPORT'?0:null);
  if(networkRequests===null)errorCode??='NETWORK_DISPATCH_COUNT_UNKNOWN';
  if(networkRequests!==null&&networkRequests!==0&&networkRequests!==1)errorCode??='NETWORK_DISPATCH_LIMIT_EXCEEDED';
  const invocation=result.invocation;
  const numeric=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
  const usageKnown=!!invocation&&numeric(invocation.inputTokens)&&numeric(invocation.outputTokens)&&Number.isFinite(invocation.latencyMs)&&invocation.latencyMs>=0;
  const cost=usageKnown?m9EstimateCostCny(invocation!.inputTokens!,invocation!.outputTokens!,permit):null;
  if(!usageKnown)errorCode??='USAGE_UNKNOWN';
  if(invocation&&(invocation.provider!=='aliyun'||invocation.model!==permit.model||invocation.promptVersion!==permit.promptVersion||invocation.attempts!==1||invocation.status!=='SUCCESS'))errorCode??='INVOCATION_METADATA_INVALID';
  if(usageKnown&&(invocation!.inputTokens!>permit.pricing.maximumModelInputTokens||invocation!.outputTokens!>permit.maxCompletionTokens+permit.pricing.completionToleranceTokens||cost!>reserve))errorCode??='USAGE_EXCEEDS_RESERVED_LIMIT';
  const rawTruncated=result.rawTruncated===true||!!(Array.isArray(result.responseEvidence)&&result.responseEvidence.some(e=>e&&typeof e==='object'&&'truncated' in e&&e.truncated===true));
  if(rawTruncated)errorCode??='RAW_OUTPUT_TRUNCATED';
  if(result.rawOutput===undefined)errorCode??='RAW_OUTPUT_MISSING';
  if(result.guardedOutput!==undefined){const parsed=diagnosisTurnSchema.safeParse(result.guardedOutput);if(parsed.success)guarded=parsed.data;else errorCode??='GUARDED_OUTPUT_SCHEMA_INVALID';}
  else errorCode??='GUARDED_OUTPUT_MISSING';
  if(guarded&&result.rawOutput!==undefined){
    try{const rawParsed=typeof result.rawOutput==='string'?JSON.parse(result.rawOutput):result.rawOutput;if(hashValue(validateDiagnosisTurn(rawParsed,context))!==hashValue(guarded))errorCode??='RAW_GUARDED_OUTPUT_MISMATCH';}
    catch{errorCode??='RAW_OUTPUT_SCHEMA_INVALID';}
  }
  const raw=sanitize(result.rawOutput,secrets),storedGuarded=sanitize(guarded,secrets);
  if((result.rawOutput!==undefined&&hashValue(raw)!==hashValue(result.rawOutput))||(guarded&&hashValue(storedGuarded)!==hashValue(guarded)))errorCode??='OUTPUT_SECRET_REDACTED';
  const reservationReleased=usageKnown&&cost!==null;
  const storedInvocation=invocation?{...invocation,...(invocation.errorClass?{errorClass:safeError({code:invocation.errorClass})}:{})}:null;
  const turn:M9Turn={caseId:sample.id,turnIndex,context,contextHash:boundary.contextHash,...(approval?{approval}:{}),...(result.rawOutput!==undefined?{rawOutput:raw,rawOutputHash:hashValue(result.rawOutput),rawStorageHash:hashValue(raw)}:{}),...(guarded?{guardedOutput:storedGuarded as DiagnosisTurn,guardedOutputHash:hashValue(guarded),guardedStorageHash:hashValue(storedGuarded)}:{}),invocation:sanitize(storedInvocation,secrets) as ModelInvocation|null,...(result.responseEvidence!==undefined?{responseEvidence:sanitize(result.responseEvidence,secrets)}:{}),...(errorCode?{errorCode}:{}),estimatedCostCny:cost,reservedSpendCny:reservationReleased?0:reserve,rawTruncated,networkRequests};
  const next:M9MultiState={...state,caseIndex,requestCount:state.requestCount+1,networkDispatches:state.networkDispatches===null||networkRequests===null?null:state.networkDispatches+networkRequests,committedSpendCny:state.committedSpendCny+(cost??0),reservedSpendCny:state.reservedSpendCny+(reservationReleased?0:reserve),turns:[...state.turns,turn],status:'ABORTED',...(errorCode?{errorCode}:{})};
  if(!errorCode&&guarded){
    if(isConversationTerminal(guarded))next.status=caseIndex===permit.caseIds.length-1?'COMPLETED':next.requestCount>=permit.maxRequests||next.committedSpendCny+next.reservedSpendCny+reserve>permit.maxSpendCny?'STOP_LIMIT':'WAITING_NEXT_CASE_APPROVAL';
    else if(turnIndex+1>=permit.maxTurnsPerSession||next.requestCount>=permit.maxRequests||next.committedSpendCny+next.reservedSpendCny+reserve>permit.maxSpendCny||!sample.studentReplies[turnIndex])next.status='STOP_LIMIT';
    else next.status='WAITING_REPLY_APPROVAL';
  }
  const completed=checkpoint(next,previous);saveJson(path.join(folder,numbered('checkpoint',completed.sequence)),completed);return completed;
}
