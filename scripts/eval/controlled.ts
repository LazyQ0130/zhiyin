import 'dotenv/config';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdirSync,readFileSync,writeFileSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {evaluationDatasetSchema,evaluationRunSchema,hashValue,type EvaluationRun} from '../../src/evaluation/schemas';
import {authorizeLive,consumeLivePermit,estimateCostCny,guardLiveRequest,reservedCostCny,QWEN_MAX_INPUT_TOKENS} from '../../src/evaluation/live-control';

if(!process.argv.includes('--controlled-worker')) {
  const result=spawnSync(process.execPath,['--conditions=react-server','--import','tsx',fileURLToPath(import.meta.url),...process.argv.slice(2),'--controlled-worker'],{stdio:'inherit'});
  process.exit(result.status??1);
}
const args=process.argv.slice(2).filter(a=>a!=='--controlled-worker');
const option=(name:string)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const runId=`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}`;
const out=path.resolve('.local/evaluations',runId);mkdirSync(out,{recursive:true});
const save=(name:string,value:unknown)=>writeFileSync(path.join(out,name),JSON.stringify(value,null,2),{flag:'wx'});
let networkRequests=0;
try {
  const dataset=evaluationDatasetSchema.parse(JSON.parse(readFileSync(option('--dataset')??'tests/evaluation/engineering.inputs.json','utf8')));
  const datasetHash=hashValue(dataset);
  const caseIds=option('--case')?.split(',')??[dataset.cases[0].id];
  if(caseIds.some(id=>!dataset.cases.some(c=>c.id===id))||new Set(caseIds).size!==caseIds.length)throw new Error('INVALID_CASE_SELECTION');
  if(!args.includes('--execute')) {
    save('plan.json',{status:'NOT_RUN',mode:'PLAN_ONLY',datasetId:dataset.datasetId,datasetHash,caseIds,networkRequests:0,actualCostCny:0,teacherQuality:'NOT_EVALUATED',reason:'No execute authorization supplied. Plan does not invoke any model.'});
    console.log(JSON.stringify({status:'NOT_RUN',networkRequests:0,actualCostCny:0,outputDirectory:out,datasetHash,caseIds}));
  } else {
    const permitPath=option('--permit');
    if(!permitPath)throw new Error('EXPLICIT_PERMISSION_FILE_REQUIRED');
    const relative=path.relative(realpathSync('.local'),realpathSync(permitPath));
    if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('PERMISSION_MUST_BE_IN_LOCAL_IGNORED_DIRECTORY');
    const permit=authorizeLive(JSON.parse(readFileSync(permitPath,'utf8')),datasetHash,caseIds);
    if(process.env.AI_MODE!=='live'||!process.env.ALIYUN_API_KEY?.trim())throw new Error('LIVE_MODE_AND_EXPLICIT_ALIYUN_KEY_REQUIRED');
    // wx enforces one-use across processes; consume before any network call, even if interrupted.
    consumeLivePermit(permit,runId,path.resolve('.local/eval-authorizations'));
    const {AliyunGateway}=await import('../../src/server/ai/providers/aliyun');
    const {GatewayError}=await import('../../src/server/ai/gateway');
    const {DIAGNOSIS_PROMPT_VERSION}=await import('../../src/server/ai/prompts/diagnosis-v1');
    const gateway=new AliyunGateway({apiKey:process.env.ALIYUN_API_KEY,baseUrl:permit.baseUrl,model:permit.model,maxRetries:0,maxCompletionTokens:permit.maxCompletionTokens,fetchImpl:async(url,init)=>{
      guardLiveRequest(String(url),init,permit,networkRequests);networkRequests++;
      return fetch(url,init);
    }});
    const run:EvaluationRun={schemaVersion:'1.0',runId,createdAt:new Date().toISOString(),datasetId:dataset.datasetId,datasetVersion:dataset.version,datasetHash,caseIds,mode:'LIVE_API',provider:'aliyun',model:permit.model,promptVersion:DIAGNOSIS_PROMPT_VERSION,records:[]};
    for(const id of caseIds){
      const item=dataset.cases.find(c=>c.id===id)!;let output:unknown;let errorCode:string|undefined;
      try{output=await gateway.createDiagnosisTurn(item.context);}catch(error){errorCode=error instanceof GatewayError?error.code:'UNEXPECTED_CLIENT_ERROR';}
      const m=gateway.lastInvocation;const cost=estimateCostCny(m?.inputTokens??null,m?.outputTokens??null,permit);
      if((m?.inputTokens??0)>QWEN_MAX_INPUT_TOKENS||(m?.outputTokens??0)>permit.maxCompletionTokens+10)errorCode='USAGE_EXCEEDS_RESERVED_LIMIT';
      run.records.push({caseId:id,inputHash:hashValue(item.context),status:errorCode?'ERROR':'SUCCESS',...(errorCode?{errorCode}:{output}),invocation:{latencyMs:m?.latencyMs??null,inputTokens:m?.inputTokens??null,outputTokens:m?.outputTokens??null,attempts:m?.attempts??0,estimatedCostCny:cost,costBasis:cost===null?null:`${permit.pricing.source}; verified=${permit.pricing.verifiedAt}; region=${permit.pricing.region}; input=${permit.pricing.inputPerMillion},output=${permit.pricing.outputPerMillion} CNY/million; no discount`}});
      // Persist after every request. A failed request halts the batch; selected missing cases score as failures.
      writeFileSync(path.join(out,'run.json'),JSON.stringify(evaluationRunSchema.parse(run),null,2));
      if(errorCode){process.exitCode=1;break;}
    }
    const costs=run.records.map(r=>r.invocation.estimatedCostCny);
    save('billing.json',{networkRequests,reservedUpperBoundCny:reservedCostCny(permit)*caseIds.length,estimatedCostCny:costs.some(c=>c===null)?null:costs.reduce<number>((a,b)=>a+(b??0),0),actualInvoiceCostCny:null,status:'PROVIDER_INVOICE_NOT_RECONCILED',warning:'Unknown usage is not free. No automatic retry, no Mock fallback. Real output still requires blind teacher review.'});
    console.log(JSON.stringify({status:process.exitCode?'FAILED':'API_RESPONSES_VALIDATED',networkRequests,outputDirectory:out,teacherReviewed:false}));
  }
} catch(error) {
  // No raw provider message, secret, prompt, or user material in logs.
  const reason=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'INVALID_CONFIG_OR_INPUT';
  save('blocked.json',{status:networkRequests===0?'NOT_RUN':'PARTIAL_FAILURE',reason,networkRequests,actualCostCny:networkRequests===0?0:null});
  console.error(JSON.stringify({status:networkRequests===0?'BLOCKED':'PARTIAL_FAILURE',reason,networkRequests,outputDirectory:out}));process.exitCode=networkRequests===0?2:1;
}
