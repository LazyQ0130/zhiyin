import {describe,it,expect} from 'vitest';
import {authorizeLive,consumeLivePermit,estimateCostCny,guardLiveRequest as guard,reservedCostCny,type LivePermit} from '../../src/evaluation/live-control';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
const now=new Date('2026-10-23T12:00:00Z');
const hash='a'.repeat(64);
const permit:LivePermit={schemaVersion:'1.0',authorizationId:'5e37dcc1-f3db-4f3e-9fd5-be9c3d48bea3',approved:true,approvedBy:'TEST_OPERATOR_NOT_ACTUAL_AUTHORIZATION',issuedAt:'2026-10-23T11:00:00Z',expiresAt:'2026-10-23T13:00:00Z',datasetHash:hash,caseIds:['case-1'],model:'qwen3.8-flash',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',maxRequests:1,maxSpendCny:1,maxCompletionTokens:2500,maxRequestBytes:10000,pricing:{currency:'CNY',inputPerMillion:0.8,outputPerMillion:2.7,source:'https://help.aliyun.com/zh/model-studio/qwen3-8-flash',verifiedAt:'2026-10-23T10:00:00Z',region:'cn-beijing'}};
const endpoint=permit.baseUrl+'/chat/completions';
const request:RequestInit={method:'POST',redirect:'error',body:JSON.stringify({model:permit.model,stream:false,enable_thinking:false,response_format:{type:'json_object'},max_completion_tokens:2500,messages:[]})};
const guardLiveRequest=(url:string,init:RequestInit,permission:LivePermit,requests:number)=>guard(url,init,permission,requests,now);
describe('explicit paid evaluation controls (no network)',()=>{
  it('accepts a time-limited exact selection only',()=>{expect(authorizeLive(permit,hash,['case-1'],now).authorizationId).toBe(permit.authorizationId);});
  it('checks expiration again immediately before every network request',()=>{
    expect(()=>guard(endpoint,request,permit,0,new Date('2026-10-23T13:00:00Z'))).toThrow('PERMIT_EXPIRED_AT_REQUEST_BOUNDARY');
  });
  it('rejects under-priced US deployment scope, undocumented regions and insecure price sources',()=>{
    expect(()=>authorizeLive({...permit,baseUrl:'https://dashscope-us.aliyuncs.com/compatible-mode/v1',pricing:{...permit.pricing,region:'us-east-1'}},hash,['case-1'],now)).toThrow('PRICE_BELOW_VERIFIED_UNDISCOUNTED_RATE');
    expect(()=>authorizeLive({...permit,baseUrl:'https://sample.cn-hongkong.maas.aliyuncs.com/compatible-mode/v1',pricing:{...permit.pricing,region:'cn-hongkong'}},hash,['case-1'],now)).toThrow('REGION_PRICE_NOT_VERIFIED');
    expect(()=>authorizeLive({...permit,pricing:{...permit.pricing,source:'http://help.aliyun.com/price'}},hash,['case-1'],now)).toThrow('OFFICIAL_PRICE_SOURCE_REQUIRED');
  });
  it.each([
    {approved:false},{model:'different-model'},{expiresAt:'2026-10-23T11:59:59Z'},
    {issuedAt:'2026-10-23T12:01:00Z'},{expiresAt:'2026-10-25T12:00:00Z'},
    {pricing:{...permit.pricing,verifiedAt:'2026-10-01T00:00:00Z'}},
    {pricing:{...permit.pricing,source:'https://unknown.example/prices'}},
    {pricing:{...permit.pricing,region:'ap-southeast-1'}},
    {pricing:{...permit.pricing,inputPerMillion:0.1}},
    {maxRequests:0},{maxRequests:4},{maxSpendCny:0.001},
  ])('blocks invalid permission %j',patch=>{expect(()=>authorizeLive({...permit,...patch},hash,['case-1'],now)).toThrow();});
  it('binds dataset content and selected cases, with no duplicate selection',()=>{
    expect(()=>authorizeLive(permit,'b'.repeat(64),['case-1'],now)).toThrow();
    expect(()=>authorizeLive(permit,hash,['case-2'],now)).toThrow();
    expect(()=>authorizeLive({...permit,caseIds:['case-1','case-1']},hash,['case-1','case-1'],now)).toThrow();
  });
  it('reserves the full model input limit plus the completion rounding margin',()=>{expect(reservedCostCny(permit)).toBeCloseTo((991808*.8+2510*2.7)/1e6,10);});
  it('never calls missing usage zero or a paid invoice',()=>{expect(estimateCostCny(null,12,permit)).toBeNull();expect(estimateCostCny(10,null,permit)).toBeNull();expect(estimateCostCny(1000,1000,permit)).toBeCloseTo(.0035);});
  it('rejects oversized batches before any request',()=>{expect(()=>authorizeLive({...permit,caseIds:['case-1','case-2']},hash,['case-1','case-2'],now)).toThrow('PERMIT_REQUEST_LIMIT');});
  it('consumes authorization once, including after a failed or interrupted run',()=>{
    const ledger=path.resolve('.local','permit-test-'+randomUUID());
    expect(()=>consumeLivePermit(permit,'first-run',ledger)).not.toThrow();
    expect(()=>consumeLivePermit(permit,'second-run',ledger)).toThrow();
  });
  it('rejects redirects, endpoint changes, hidden retries, and parameter drift at fetch boundary',()=>{
    expect(()=>guardLiveRequest(endpoint,request,permit,0)).not.toThrow();
    expect(()=>guardLiveRequest(endpoint,request,permit,1)).toThrow();
    expect(()=>guardLiveRequest('https://evil.example',request,permit,0)).toThrow();
    expect(()=>guardLiveRequest(endpoint,{...request,redirect:'follow'},permit,0)).toThrow();
    expect(()=>guardLiveRequest(endpoint,{...request,body:JSON.stringify({...JSON.parse(String(request.body)),enable_thinking:true})},permit,0)).toThrow();
    expect(()=>guardLiveRequest(endpoint,{...request,body:'x'.repeat(10001)},permit,0)).toThrow();
  });
});
