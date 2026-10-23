import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {describe,expect,it,vi} from 'vitest';
import {startM9MultiRun,resumeM9MultiRun,readM9MultiRun,type M9MultiCheckpoint,type M9MultiRunOptions,type M9InvocationResult,type M9Invoke} from '../../src/evaluation/m9-multi-runner';
import {m9ReservedCostCny} from '../../src/evaluation/m9-multi-permit';
import {hashValue} from '../../src/evaluation/schemas';
import {advanceConversationContext} from '../../src/evaluation/conversation-score';
import type {DiagnosisContext} from '../../src/server/ai/gateway';
import type {DiagnosisTurn} from '../../src/server/ai/schemas/diagnosis';
import {validateDiagnosisTurn} from '../../src/server/ai/validate-turn';
import {m9MultiUnitFixture,M9_UNIT_NOW} from './m9-multi-fixture';

const rawTurn=(terminal=false):DiagnosisTurn=>({schemaVersion:'1.0',action:terminal?'MARK_INCONCLUSIVE':'ASK_ONE_QUESTION',studentFacingText:'UNIT：具体原因仍待确认。',referencedStepIds:[],findings:[],followUpQuestion:terminal?null:'UNIT：请说明这一步的想法？',hintLevel:0,safetyFlags:[]});
function response(context:DiagnosisContext,raw:unknown=rawTurn()):M9InvocationResult {
  return {rawOutput:JSON.stringify(raw),guardedOutput:validateDiagnosisTurn(raw,context),invocation:{provider:'aliyun',model:'qwen3.8-flash',promptVersion:'diagnosis-v1.1.0-evidence',inputTokens:100,outputTokens:20,latencyMs:1,attempts:1,status:'SUCCESS',costEstimate:null},responseEvidence:[{httpStatus:200,finishReason:'stop',truncated:false}],networkRequests:0};
}
function setup(caseCount=1,invoke:M9Invoke=async context=>response(context)) {
  const fixture=m9MultiUnitFixture(caseCount),base=path.resolve('.local','m9-runner-unit',randomUUID());
  const options:M9MultiRunOptions={permit:{...fixture.permit,authorizationId:randomUUID()},binding:fixture.binding,invoke,executionMode:'SYNTHETIC_TRANSPORT',directory:path.join(base,'runs'),ledgerDirectory:path.join(base,'ledger'),now:M9_UNIT_NOW};
  return {...fixture,options};
}
function approval(checkpoint:M9MultiCheckpoint,fixture:ReturnType<typeof setup>) {
  const last=checkpoint.state.turns.at(-1)!,reply=fixture.dataset.cases.find(c=>c.id===last.caseId)!.studentReplies[last.turnIndex];
  return {schemaVersion:'M9.REPLY.1',action:'REPLY',approved:true,approvedBy:'UNIT_NOT_AN_ACTUAL_APPROVAL',approvedAt:M9_UNIT_NOW.toISOString(),authorizationId:checkpoint.state.authorizationId,runId:checkpoint.state.runId,caseId:last.caseId,turnIndex:last.turnIndex,previousCheckpointHash:checkpoint.checkpointHash,previousGuardedOutputHash:last.guardedOutputHash,replyId:reply.id,replyContent:reply.content,replyHash:hashValue(reply)};
}
const nextCaseApproval=(checkpoint:M9MultiCheckpoint,fixture:ReturnType<typeof setup>)=>{
  const {replyId:_,replyContent:__,replyHash:___,...base}=approval(checkpoint,fixture);void _;void __;void ___;
  return {...base,action:'NEXT_CASE',nextCaseId:fixture.dataset.cases[1].id};
};
describe('M9 durable one-request human-gated executor (synthetic transport only)',()=>{
  it('saves raw and guarded hashes, consumes once, pauses after exactly one request',async()=>{
    const invoke=vi.fn(async(context:DiagnosisContext)=>response(context)),fixture=setup(1,invoke),first=await startM9MultiRun(fixture.options);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(first.state).toMatchObject({executionMode:'SYNTHETIC_TRANSPORT',status:'WAITING_REPLY_APPROVAL',requestCount:1,networkDispatches:0,reservedSpendCny:0});
    const turn=first.state.turns[0];expect(turn.rawOutputHash).toBe(hashValue(turn.rawOutput));expect(turn.guardedOutputHash).toBe(hashValue(turn.guardedOutput));
    expect(readM9MultiRun(fixture.options.directory,first.state.runId)).toEqual(first);
    await expect(startM9MultiRun(fixture.options)).rejects.toThrow();expect(invoke).toHaveBeenCalledTimes(1);
    const ledger=JSON.parse(readFileSync(path.join(fixture.options.ledgerDirectory!,first.state.authorizationId+'.json'),'utf8'));expect(ledger).toMatchObject({runId:first.state.runId,permitHash:first.state.permitHash});
  });
  it('advances only with exact human reply approval and refuses stale approval reuse',async()=>{
    const fixture=setup(),first=await startM9MultiRun(fixture.options),signed=approval(first,fixture);
    await expect(resumeM9MultiRun({...fixture.options,runId:first.state.runId,approval:{...signed,approved:false}})).rejects.toThrow();
    await expect(resumeM9MultiRun({...fixture.options,runId:first.state.runId,approval:{...signed,replyContent:'UNIT edited answer'}})).rejects.toThrow('EXACT_SCRIPT_REPLY_APPROVAL_REQUIRED');
    const second=await resumeM9MultiRun({...fixture.options,runId:first.state.runId,approval:signed});
    expect(second.state.status).toBe('WAITING_REPLY_APPROVAL');expect(second.state.requestCount).toBe(2);
    expect(second.state.turns[1].context).toEqual(advanceConversationContext(fixture.dataset.cases[0],first.state.turns[0].context,first.state.turns[0].guardedOutput!,0,'M8.1'));
    await expect(resumeM9MultiRun({...fixture.options,runId:first.state.runId,approval:signed})).rejects.toThrow('APPROVAL_BINDING_MISMATCH');
    expect(readdirSync(path.join(fixture.options.directory!,first.state.runId)).filter(f=>f.startsWith('claim-'))).toHaveLength(2);
  });
  it('requires separate NEXT_CASE confirmation after terminal output',async()=>{
    const invoke=vi.fn(async(context:DiagnosisContext)=>response(context,rawTurn(true))),fixture=setup(2,invoke),first=await startM9MultiRun(fixture.options);
    expect(first.state.status).toBe('WAITING_NEXT_CASE_APPROVAL');expect(invoke).toHaveBeenCalledTimes(1);
    await expect(resumeM9MultiRun({...fixture.options,runId:first.state.runId,approval:approval(first,fixture)})).rejects.toThrow('NEXT_CASE_APPROVAL_REQUIRED');
    const last=await resumeM9MultiRun({...fixture.options,runId:first.state.runId,approval:nextCaseApproval(first,fixture)});
    expect(last.state.status).toBe('COMPLETED');expect(invoke).toHaveBeenCalledTimes(2);expect(last.state.turns[1].context).toEqual(fixture.dataset.cases[1].initialContext);
  });
  it('stops a nonterminal session at the turn limit without calling it reasonable abstention',async()=>{
    const invoke=vi.fn(async(context:DiagnosisContext)=>response(context)),fixture=setup(1,invoke);
    let current=await startM9MultiRun(fixture.options);
    for(let i=0;i<2;i++)current=await resumeM9MultiRun({...fixture.options,runId:current.state.runId,approval:approval(current,fixture)});
    expect(current.state.status).toBe('STOP_LIMIT');expect(current.state.turns.at(-1)!.guardedOutput!.action).toBe('ASK_ONE_QUESTION');expect(invoke).toHaveBeenCalledTimes(3);
    await expect(resumeM9MultiRun({...fixture.options,runId:current.state.runId,approval:{}})).rejects.toThrow('RUN_NOT_RESUMABLE:STOP_LIMIT');
  });
  it.each(['missing usage','invalid schema','invalid JSON','connection error','truncated raw'])('aborts %s and preserves charged request evidence',async failure=>{
    const fixture=setup(1,async context=>{
      const result=response(context);
      if(failure==='missing usage')result.invocation!.inputTokens=null;
      if(failure==='invalid schema')result.guardedOutput={bad:true};
      if(failure==='invalid JSON'){result.rawOutput='{bad JSON';result.guardedOutput=undefined;result.errorCode='AI_INVALID_OUTPUT';}
      if(failure==='connection error')throw Object.assign(new Error('UNIT_PRIVATE_ERROR_NOT_TO_BE_STORED'),{code:'AI_UNAVAILABLE'});
      if(failure==='truncated raw')result.rawTruncated=true;
      return result;
    });
    const aborted=await startM9MultiRun(fixture.options);expect(aborted.state.status).toBe('ABORTED');expect(aborted.state.requestCount).toBe(1);
    if(['missing usage','connection error'].includes(failure)){expect(aborted.state.reservedSpendCny).toBe(m9ReservedCostCny(fixture.permit));expect(aborted.state.turns[0].estimatedCostCny).toBeNull();}
    await expect(resumeM9MultiRun({...fixture.options,runId:aborted.state.runId,approval:{}})).rejects.toThrow('RUN_NOT_RESUMABLE:ABORTED');
    expect(readFileSync(path.join(fixture.options.directory!,aborted.state.runId,'checkpoint-000001.json'),'utf8')).not.toContain('UNIT_PRIVATE_ERROR_NOT_TO_BE_STORED');
  });
  it('enforces timeout with no retry and keeps the worst-case reservation',async()=>{
    const invoke=vi.fn(async()=>new Promise<M9InvocationResult>(()=>{})),fixture=setup(1,invoke);fixture.options.permit={...fixture.permit,authorizationId:randomUUID(),timeoutMs:5};
    const aborted=await startM9MultiRun(fixture.options);expect(aborted.state.errorCode).toBe('AI_TIMEOUT');expect(aborted.state.reservedSpendCny).toBe(m9ReservedCostCny(fixture.permit));expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('persists the count and reserve claim before invoke; competing resumes cannot dispatch',async()=>{
    const fixture=setup(),first=await startM9MultiRun(fixture.options);let release!:(result:M9InvocationResult)=>void;
    fixture.options.invoke=async(context,boundary)=>{
      const claim=JSON.parse(readFileSync(path.join(fixture.options.directory!,first.state.runId,'claim-000002.json'),'utf8'));
      expect(claim).toMatchObject({requestNumber:2,reservedSpendCny:m9ReservedCostCny(fixture.permit),contextHash:hashValue(context)});expect(boundary.requests).toBe(1);
      return new Promise(resolve=>{release=()=>resolve(response(context));});
    };
    const pending=resumeM9MultiRun({...fixture.options,runId:first.state.runId,approval:approval(first,fixture)});
    expect(readM9MultiRun(fixture.options.directory,first.state.runId).state).toMatchObject({status:'NONRESUMABLE_PENDING_CLAIM',requestCount:2,reservedSpendCny:m9ReservedCostCny(fixture.permit),networkDispatches:null});
    await expect(resumeM9MultiRun({...fixture.options,runId:first.state.runId,approval:approval(first,fixture)})).rejects.toThrow('RUN_NOT_RESUMABLE:NONRESUMABLE_PENDING_CLAIM');
    release({invocation:null});await pending;
  });
  it('fails closed on changed checkpoint prefixes or missing original ledger binding',async()=>{
    const fixture=setup(),first=await startM9MultiRun(fixture.options),file=path.join(fixture.options.directory!,first.state.runId,'checkpoint-000001.json');
    const changed=JSON.parse(readFileSync(file,'utf8'));changed.state.turns[0].context.questionText='UNIT tampered';writeFileSync(file,JSON.stringify(changed));
    expect(()=>readM9MultiRun(fixture.options.directory,first.state.runId)).toThrow('CHECKPOINT_HASH_OR_PREFIX_INVALID');
    const other=setup(),valid=await startM9MultiRun(other.options);writeFileSync(path.join(other.options.ledgerDirectory!,valid.state.authorizationId+'.json'),JSON.stringify({runId:'UNIT_OTHER_RUN'}));
    await expect(resumeM9MultiRun({...other.options,runId:valid.state.runId,approval:approval(valid,other)})).rejects.toThrow('ORIGINAL_LEDGER_BINDING_REQUIRED');
  });
  it('redacts exact keys and sensitive evidence fields; altered output cannot resume',async()=>{
    const secret='UNIT_PRIVATE_CREDENTIAL_123456',fixture=setup(1,async context=>({...response(context,{...rawTurn(),studentFacingText:secret}),responseEvidence:{Authorization:'Bearer '+secret,apiKey:secret}}));fixture.options.redactSecrets=[secret];
    const aborted=await startM9MultiRun(fixture.options),serialized=readFileSync(path.join(fixture.options.directory!,aborted.state.runId,'checkpoint-000001.json'),'utf8');
    expect(aborted.state.status).toBe('ABORTED');expect(aborted.state.errorCode).toBe('OUTPUT_SECRET_REDACTED');expect(serialized).not.toContain(secret);expect(serialized).toContain('[REDACTED]');
    expect(aborted.state.turns[0].rawOutputHash).not.toBe(aborted.state.turns[0].rawStorageHash);expect(readM9MultiRun(fixture.options.directory,aborted.state.runId).state.status).toBe('ABORTED');
  });
  it('redacts dotted workspace credentials even when they were not explicitly supplied',async()=>{
    const dotted=['sk','ws','UNIT.first-part.second_part-1234'].join('-'),fixture=setup(1,async context=>response(context,{...rawTurn(),studentFacingText:'UNIT '+dotted}));
    const aborted=await startM9MultiRun(fixture.options),serialized=readFileSync(path.join(fixture.options.directory!,aborted.state.runId,'checkpoint-000001.json'),'utf8');
    expect(aborted.state.errorCode).toBe('OUTPUT_SECRET_REDACTED');expect(serialized).not.toContain(dotted);expect(serialized).not.toContain('second_part');
  });
  it('distinguishes claimed attempts from confirmed zero dispatches after preflight failure',async()=>{
    const fixture=setup(1,async()=>({invocation:null,errorCode:'AI_NOT_CONFIGURED',networkRequests:0}));
    const aborted=await startM9MultiRun(fixture.options);expect(aborted.state).toMatchObject({status:'ABORTED',requestCount:1,networkDispatches:0});expect(aborted.state.reservedSpendCny).toBe(m9ReservedCostCny(fixture.permit));
  });
});
