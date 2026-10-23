import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createM9Invocation,expectedM9Body} from '../../scripts/eval/m9-multi';
import {startM9MultiRun,resumeM9MultiRun,type M9RequestBoundary} from '../../src/evaluation/m9-multi-runner';
import {hashValue} from '../../src/evaluation/schemas';
import {m9EstimateCostCny} from '../../src/evaluation/m9-multi-permit';
import type {DiagnosisContext} from '../../src/server/ai/gateway';
import type {DiagnosisTurn} from '../../src/server/ai/schemas/diagnosis';
import {m9MultiUnitFixture,M9_UNIT_NOW} from './m9-multi-fixture';

const rawTurn:DiagnosisTurn={schemaVersion:'1.0',action:'ASK_ONE_QUESTION',studentFacingText:'UNIT：原因仍待确认。',referencedStepIds:[],findings:[],followUpQuestion:'UNIT：请说明这一步的想法？',hintLevel:0,safetyFlags:[]};
const envelope=(content=JSON.stringify(rawTurn),finishReason='stop')=>({choices:[{message:{content},finish_reason:finishReason}],usage:{prompt_tokens:120,completion_tokens:30}});
function boundary(context:DiagnosisContext,fixture:ReturnType<typeof m9MultiUnitFixture>):M9RequestBoundary {
  return {caseId:fixture.dataset.cases[0].id,inputHash:fixture.permit.caseInputHashes[fixture.dataset.cases[0].id],turnIndex:0,contextHash:hashValue(context),requests:0,committedSpendCny:0,reservedSpendCny:0,requestNumber:1,usageKnown:true};
}
const fakeTransport=(value:unknown)=>vi.fn<typeof fetch>(async()=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json','x-request-id':'UNIT_SYNTHETIC_RESPONSE'}}));

describe('M9 CLI bridge with injected synthetic fetch only',()=>{
  beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(M9_UNIT_NOW);vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('NATIVE_NETWORK_FORBIDDEN_IN_UNIT_TEST');}));});
  afterEach(()=>{expect(globalThis.fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();vi.useRealTimers();});

  it('binds the exact request body, saves known synthetic usage, and pauses for every scripted reply',async()=>{
    const fixture=m9MultiUnitFixture(),transport=fakeTransport(envelope()),dispatch=vi.fn(),permit={...fixture.permit,authorizationId:randomUUID()};
    const invoke=await createM9Invocation(permit,'UNIT_NOT_A_REAL_KEY',transport,dispatch),base=path.resolve('.local','m9-cli-unit',randomUUID());
    const options={permit,binding:fixture.binding,invoke,executionMode:'SYNTHETIC_TRANSPORT' as const,directory:path.join(base,'runs'),ledgerDirectory:path.join(base,'ledger'),now:M9_UNIT_NOW};
    const first=await startM9MultiRun(options);
    expect(first.state).toMatchObject({executionMode:'SYNTHETIC_TRANSPORT',status:'WAITING_REPLY_APPROVAL',requestCount:1,networkDispatches:1,reservedSpendCny:0});
    expect(first.state.turns[0]).toMatchObject({rawOutput:JSON.stringify(rawTurn),invocation:{inputTokens:120,outputTokens:30,attempts:1,status:'SUCCESS'}});
    expect(first.state.committedSpendCny).toBe(m9EstimateCostCny(120,30,permit));
    expect(transport).toHaveBeenCalledTimes(1);expect(dispatch).toHaveBeenCalledTimes(1);
    const [url,init]=transport.mock.calls[0];expect(url).toBe(permit.baseUrl+'/chat/completions');expect(init!.body).toBe(expectedM9Body(fixture.dataset.cases[0].initialContext,permit));
    const data=JSON.parse(JSON.parse(String(init!.body)).messages[1].content).untrustedStudentMaterial;expect(data.maximumTurns).toBe(3);expect(data).not.toHaveProperty('teacherGoldDecisions');
    const reply=fixture.dataset.cases[0].studentReplies[0];
    const second=await resumeM9MultiRun({...options,runId:first.state.runId,approval:{schemaVersion:'M9.REPLY.1',action:'REPLY',approved:true,approvedBy:'UNIT_NOT_ACTUAL_OPERATOR',approvedAt:M9_UNIT_NOW.toISOString(),authorizationId:permit.authorizationId,runId:first.state.runId,caseId:fixture.dataset.cases[0].id,turnIndex:0,previousCheckpointHash:first.checkpointHash,previousGuardedOutputHash:first.state.turns[0].guardedOutputHash,replyId:reply.id,replyContent:reply.content,replyHash:hashValue(reply)}});
    expect(second.state.status).toBe('WAITING_REPLY_APPROVAL');expect(transport).toHaveBeenCalledTimes(2);expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it.each([{name:'invalid diagnosis JSON',content:'{UNIT invalid json',finish:'stop'},{name:'length finish reason',content:JSON.stringify(rawTurn),finish:'length'}])('retains raw output and known error usage for $name',async({content,finish})=>{
    const fixture=m9MultiUnitFixture(),context=fixture.dataset.cases[0].initialContext,transport=fakeTransport(envelope(content,finish)),dispatch=vi.fn();
    const invoke=await createM9Invocation(fixture.permit,'UNIT_NOT_A_REAL_KEY',transport,dispatch),result=await invoke(context,boundary(context,fixture));
    expect(result).toMatchObject({rawOutput:content,errorCode:'AI_INVALID_OUTPUT',networkRequests:1,invocation:{status:'ERROR',inputTokens:120,outputTokens:30,attempts:1}});
    expect(result).not.toHaveProperty('guardedOutput');expect(result.responseEvidence).toMatchObject([{httpStatus:200,finishReason:finish,errorCode:'AI_INVALID_OUTPUT'}]);expect(transport).toHaveBeenCalledTimes(1);expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(['wrong context hash','wrong case','request cap','expired permit'])('blocks %s at the preflight boundary without dispatch',async failure=>{
    const fixture=m9MultiUnitFixture(),context=fixture.dataset.cases[0].initialContext,transport=fakeTransport(envelope()),dispatch=vi.fn(),request=boundary(context,fixture);
    if(failure==='wrong context hash')request.contextHash=hashValue('UNIT_OTHER_CONTEXT');
    if(failure==='wrong case')request.caseId='UNIT_UNLICENSED_CASE';
    if(failure==='request cap')request.requests=fixture.permit.maxRequests;
    if(failure==='expired permit')vi.setSystemTime(new Date(fixture.permit.expiresAt));
    const invoke=await createM9Invocation(fixture.permit,'UNIT_NOT_A_REAL_KEY',transport,dispatch),result=await invoke(context,request);
    expect(result).toMatchObject({networkRequests:0,errorCode:'AI_UNAVAILABLE',invocation:{status:'ERROR',inputTokens:null,outputTokens:null,attempts:1}});expect(transport).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects start without --execute before loading configuration or credentials',()=>{
    const child=spawnSync(process.execPath,['--conditions=react-server','--import','tsx','scripts/eval/m9-multi.ts','start','.local/UNIT_DOES_NOT_EXIST_CONFIG.json'],{cwd:process.cwd(),env:{...process.env,ALIYUN_API_KEY:'',DASHSCOPE_API_KEY:''},encoding:'utf8',timeout:15000,windowsHide:true});
    expect(child.error).toBeUndefined();expect(child.status).toBe(2);expect(child.stdout).toBe('');expect(JSON.parse(child.stderr.trim())).toEqual({status:'BLOCKED',reason:'CHECK_OR_STATUS_OR_EXPLICIT_EXECUTE_REQUIRED',networkDispatches:0,newActualCostCny:0});expect(child.stderr).not.toContain('AI_KEY_NOT_CONFIGURED');
  });
});
