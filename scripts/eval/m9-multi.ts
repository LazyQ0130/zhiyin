import {createHash} from 'node:crypto';
import {existsSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import type {DiagnosisContext} from '../../src/server/ai/gateway';
import {DIAGNOSIS_SYSTEM_PROMPT} from '../../src/server/ai/prompts/diagnosis-v1';
import {deterministicToolResults} from '../../src/server/ai/validate-turn';
import {conversationDatasetSchema} from '../../src/evaluation/conversation-schemas';
import {M9_RULE_FILES} from '../../src/evaluation/m9-live-plan';
import {authorizeM9MultiPermit,guardM9MultiRequest,M9_MULTI_LEDGER_DIRECTORY,m9MultiPermitSchema,type M9MultiBinding,type M9MultiPermit} from '../../src/evaluation/m9-multi-permit';
import {readM9MultiRun,resumeM9MultiRun,startM9MultiRun,type M9Invoke,type M9MultiCheckpoint} from '../../src/evaluation/m9-multi-runner';
import {hashValue} from '../../src/evaluation/schemas';

const configSchema=z.strictObject({schemaVersion:z.literal('M9.MULTI.CONFIG.1'),datasetFile:z.string().min(1),permitFile:z.string().min(1),teacherGoldDecisionsFile:z.string().min(1),signedSourceFiles:z.array(z.string().min(1)).min(2)});
const json=(file:string):unknown=>JSON.parse(readFileSync(file,'utf8'));
const directory=path.resolve('.local/m9-live');
function privateFile(file:string):string {
  const resolved=realpathSync(file),relative=path.relative(realpathSync('.local'),resolved);
  if(relative.startsWith('..')||path.isAbsolute(relative)||relative==='')throw new Error('PRIVATE_LOCAL_FILE_REQUIRED');
  return resolved;
}
function loadConfiguration(file:string,validatePermission=true):{permit:M9MultiPermit;binding:M9MultiBinding} {
  const configFile=privateFile(path.resolve(file)),config=configSchema.parse(json(configFile)),base=path.dirname(configFile);
  const resolve=(value:string)=>path.resolve(base,value);
  const permit=m9MultiPermitSchema.parse(json(privateFile(resolve(config.permitFile))));
  const decisions=z.array(z.unknown()).parse(json(privateFile(resolve(config.teacherGoldDecisionsFile))));
  const sourceHashes=Object.fromEntries(M9_RULE_FILES.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
  const binding:M9MultiBinding={dataset:json(resolve(config.datasetFile)),caseIds:permit.caseIds,sourceHashes,teacherGoldDecisions:decisions,signedSourceBytes:config.signedSourceFiles.map(file=>readFileSync(privateFile(resolve(file))))};
  if(validatePermission)authorizeM9MultiPermit(permit,binding);
  return {permit,binding};
}

/** Independent expectation from the trusted, journal-derived context, before provider construction. */
export function expectedM9Body(context:DiagnosisContext,permit:M9MultiPermit):string {
  const data={...context,messages:context.messages.slice(-12),toolResults:deterministicToolResults(context),maximumTurns:permit.maxTurnsPerSession};
  return JSON.stringify({model:permit.model,messages:[{role:'system',content:DIAGNOSIS_SYSTEM_PROMPT},{role:'user',content:JSON.stringify({untrustedStudentMaterial:data})}],stream:false,enable_thinking:false,response_format:{type:'json_object'},max_completion_tokens:permit.maxCompletionTokens});
}

/** No default network transport: the live entry point must explicitly supply fetch after all gates. */
export async function createM9Invocation(permit:M9MultiPermit,apiKey:string,transport:typeof fetch,onDispatch:()=>void):Promise<M9Invoke> {
  const {AliyunGateway}=await import('../../src/server/ai/providers/aliyun');
  return async(context,boundary)=>{
    let rawOutput:string|undefined,sent:0|1=0;
    const expectedBodyHash=hashValue(expectedM9Body(context,permit));
    const gateway=new AliyunGateway({apiKey,baseUrl:permit.baseUrl,model:permit.model,maxRetries:0,maxCompletionTokens:permit.maxCompletionTokens,maximumDiagnosisTurns:permit.maxTurnsPerSession,timeoutMs:permit.timeoutMs,
      onRawDiagnosisOutput:text=>{rawOutput=text;},fetchImpl:async(url,init)=>{
        guardM9MultiRequest(String(url),init,permit,{...boundary,expectedBodyHash,expectedContext:context});
        if(sent!==0)throw new Error('ONE_DISPATCH_ONLY');
        sent=1;onDispatch();return transport(url,init);
      }});
    try {
      const guardedOutput=await gateway.createDiagnosisTurn(context);
      return {rawOutput,guardedOutput,invocation:gateway.lastInvocation,responseEvidence:gateway.lastResponseEvidence,networkRequests:sent};
    } catch(error) {
      const code=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^AI_[A-Z_]+$/.test(error.code)?error.code:'AI_UNAVAILABLE';
      return {rawOutput,invocation:gateway.lastInvocation,responseEvidence:gateway.lastResponseEvidence,errorCode:code,networkRequests:sent};
    }
  };
}

function present(checkpoint:M9MultiCheckpoint,binding:M9MultiBinding) {
  const state=checkpoint.state,last=state.turns.at(-1);
  let approvalDraft:string|undefined;
  if(last&&['WAITING_REPLY_APPROVAL','WAITING_NEXT_CASE_APPROVAL'].includes(state.status)){
    const base={schemaVersion:'M9.REPLY.1',approved:false,approvedBy:'',approvedAt:null,authorizationId:state.authorizationId,runId:state.runId,caseId:last.caseId,turnIndex:last.turnIndex,previousCheckpointHash:checkpoint.checkpointHash,previousGuardedOutputHash:last.guardedOutputHash};
    const sample=conversationDatasetSchema.parse(binding.dataset).cases.find(sample=>sample.id===last.caseId)!;
    const reply=sample.studentReplies[last.turnIndex];
    const draft=state.status==='WAITING_REPLY_APPROVAL'?{...base,action:'REPLY',replyId:reply.id,replyContent:reply.content,replyHash:hashValue(reply)}:{...base,action:'NEXT_CASE',nextCaseId:state.caseIds[state.caseIndex+1]};
    approvalDraft=path.join(directory,state.runId,`approval-${checkpoint.checkpointHash}.draft.json`);
    try{writeFileSync(approvalDraft,JSON.stringify(draft,null,2)+'\n',{flag:'wx',mode:0o600});}catch(error){if(!(error&&typeof error==='object'&&'code' in error&&error.code==='EEXIST'))throw error;}
  }
  console.log(JSON.stringify({runId:state.runId,status:state.status,executionMode:state.executionMode,claimedRequests:state.requestCount,networkDispatches:state.networkDispatches,estimatedSpendCny:state.committedSpendCny,unresolvedReservedCny:state.reservedSpendCny,actualBilledCostCny:null,errorCode:state.errorCode??null,directory:path.join(directory,state.runId),approvalDraft:approvalDraft??null},null,2));
  if(['ABORTED','STOP_LIMIT','NONRESUMABLE_PENDING_CLAIM'].includes(state.status))process.exitCode=2;
}

let networkDispatches=0;
async function main() {
  const [command,configFile,runId,approvalFile,...rest]=process.argv.slice(2);
  const args=process.argv.slice(2);
  if(!configFile||!['check','start','status','resume'].includes(command??'')||
    (command==='check'&&args.length!==2)||(command==='status'&&args.length!==3)||
    (command==='start'&&(args.length!==3||runId!=='--execute'))||
    (command==='resume'&&(args.length!==5||rest[0]!=='--execute')))throw new Error('CHECK_OR_STATUS_OR_EXPLICIT_EXECUTE_REQUIRED');
  const {permit,binding}=loadConfiguration(configFile,command!=='status');
  if(command==='check'){
    if(existsSync(path.join(M9_MULTI_LEDGER_DIRECTORY,`${permit.authorizationId}.json`)))throw new Error('AUTHORIZATION_ALREADY_CONSUMED');
    console.log(JSON.stringify({status:'READY_FOR_SEPARATE_AUTHORIZED_EXECUTION',networkRequests:0,newActualCostCny:0,authorizationId:permit.authorizationId,caseIds:permit.caseIds}));return;
  }
  if(command==='status'){
    const checkpoint=readM9MultiRun(directory,runId);
    if(checkpoint.state.permitHash!==hashValue(permit)||checkpoint.state.datasetHash!==hashValue(conversationDatasetSchema.parse(binding.dataset)))throw new Error('STATUS_CONFIGURATION_BINDING_CHANGED');
    present(checkpoint,binding);return;
  }
  // Credentials and provider are not loaded by check/status or before approval/data validation.
  const {config}=await import('dotenv');config({quiet:true});
  const apiKey=process.env.ALIYUN_API_KEY??process.env.DASHSCOPE_API_KEY??'';
  if(!apiKey.trim())throw new Error('AI_KEY_NOT_CONFIGURED');
  const invoke=await createM9Invocation(permit,apiKey,fetch,()=>{networkDispatches++;});
  const options={permit,binding,invoke,executionMode:'LIVE_API' as const,directory,redactSecrets:[apiKey]};
  const checkpoint=command==='start'?await startM9MultiRun(options):await resumeM9MultiRun({...options,runId,approval:json(privateFile(path.resolve(approvalFile)))});
  present(checkpoint,binding);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  main().catch(error=>{console.error(JSON.stringify({status:'BLOCKED',reason:error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'INVALID_INPUT_OR_EXECUTION_STOPPED',networkDispatches,newActualCostCny:networkDispatches===0?0:null}));process.exitCode=2;});
}
