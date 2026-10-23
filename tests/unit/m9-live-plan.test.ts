import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {buildM9LivePlan,checkM9LivePlan,M9_RULE_FILES,m9LivePlanSchema} from '../../src/evaluation/m9-live-plan';
import {hashValue} from '../../src/evaluation/schemas';
import {livePermitSchema} from '../../src/evaluation/live-control';

const dataset=JSON.parse(readFileSync('tests/evaluation/m7/math-candidates.inputs.json','utf8'));
const now=new Date('2026-10-23T14:00:00Z');
const hashes=Object.fromEntries(M9_RULE_FILES.map(file=>[file,hashValue('UNIT_FIXTURE:'+file)]));
const build=()=>buildM9LivePlan(dataset,hashes,now.toISOString(),now);
describe('M9 reviewed proposal never authorizes model execution',()=>{
  it('binds three DEV originals and uses the whole model input ceiling for its worst-case reserve',()=>{
    const envelope=build(),r=checkM9LivePlan(envelope,dataset,hashes,now);
    expect(envelope.plan.dataset.cases.map(c=>c.caseId)).toEqual(['m7-d04','m7-d16','m7-d23']);
    expect(r).toMatchObject({status:'NOT_READY',networkRequests:0,newActualCostCny:0,teacherReviewedCases:0,maximumNetworkRequests:9});
    expect(r.budget.reservedUpperBoundCny).toBeCloseTo(7.2020106,7);
    expect(r.budget.withinProposedCeiling).toBe(true);
    expect(r.blockers).toContain('LIVE_MULTI_TURN_EXECUTOR_NOT_IMPLEMENTED');
    expect(livePermitSchema.safeParse(envelope).success).toBe(false);
  });
  it('rejects a selected BLIND case instead of preparing a prompt-tuning run',()=>{
    const changed=structuredClone(dataset);changed.cases.find((c:{id:string})=>c.id==='m7-d04').split='BLIND';
    expect(()=>buildM9LivePlan(changed,hashes,now.toISOString(),now)).toThrow('DEV_PROVISIONAL_SELECTION_REQUIRED');
  });
  it('does not silently label author cases teacher-reviewed',()=>{
    const changed=structuredClone(dataset);changed.provenance='AUTHOR_CREATED_TEACHER_REVIEWED';
    expect(()=>buildM9LivePlan(changed,hashes,now.toISOString(),now)).toThrow('PLAN_REQUIRES_FROZEN_PROVISIONAL_PARENT');
  });
  it('requires both immutable input and current rule source hashes',()=>{
    const envelope=build(),changed=structuredClone(dataset);changed.cases[0].initialContext.questionText+=' changed';
    expect(()=>checkM9LivePlan(envelope,changed,hashes,now)).toThrow('PLAN_DATASET_CHANGED');
    expect(()=>checkM9LivePlan(envelope,dataset,{...hashes,[M9_RULE_FILES[0]]:hashValue('changed')},now)).toThrow('PLAN_RULE_SOURCES_CHANGED');
  });
  it.each(['authorization','maxNetworkRequests','maxRetries','planHash'])('cannot turn a proposal into permission by changing %s',field=>{
    const envelope=build();
    if(field==='authorization')(envelope.plan as {authorization:string}).authorization='APPROVED';
    else if(field==='planHash')envelope.planHash=hashValue('different');
    else (envelope.plan.limits as unknown as Record<string,number>)[field]=30;
    expect(m9LivePlanSchema.safeParse(envelope).success).toBe(false);
  });
  it('reports stale pricing as another unresolved gate, without claiming a fresh verification',()=>{
    const r=checkM9LivePlan(build(),dataset,hashes,new Date('2026-11-01T00:00:00Z'));
    expect(r.blockers).toContain('OFFICIAL_PRICE_RECHECK_REQUIRED');
    expect(r.status).toBe('NOT_READY');
  });
});
