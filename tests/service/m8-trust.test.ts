import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {afterAll,describe,expect,it,vi} from 'vitest';
import {Prisma} from '@/generated/prisma/client';
import {db} from '@/lib/db';
import {runTurn} from '@/server/services/diagnosis';
import {getSession,sessionDTO,submissionDTO} from '@/server/services/queries';
import {createPractice,submitPractice,useHint} from '@/server/services/practice';
import {MockGateway} from '@/server/ai/providers/mock';
import type {DiagnosisContext} from '@/server/ai/gateway';
import type {DiagnosisTurn} from '@/server/ai/schemas/diagnosis';

const evidence:Record<string,unknown>[]=[];
class OverclaimingFixture extends MockGateway{
  async createDiagnosisTurn(c:DiagnosisContext):Promise<DiagnosisTurn>{
    return {schemaVersion:'1.0',action:'ASK_ONE_QUESTION',studentFacingText:'判别式使用 b²−4ac，请说明这一步的思路？',followUpQuestion:'请说明这一步的思路？',referencedStepIds:[c.steps[1].id],hintLevel:0,safetyFlags:[],findings:[
      {findingKey:'candidate',category:'KNOWLEDGE',statement:'判别式公式记错了。',status:'SUPPORTED',verificationNeeded:false,supportingEvidence:[{kind:'STUDENT_STEP',sourceId:c.steps[1].id}],contradictingEvidence:[]},
      {findingKey:'downstream',category:'EXECUTION',statement:'后续求根运算出现了独立错误。',status:'SUPPORTED',verificationNeeded:false,supportingEvidence:[{kind:'STUDENT_STEP',sourceId:c.steps[2].id}],contradictingEvidence:[]},
    ]};
  }
}
async function fixture(){
  const user=await db.user.create({data:{email:`m8-service-${randomUUID()}@example.test`,passwordHash:'SYNTHETIC_NOT_LOGIN_HASH',profile:{create:{displayName:'M8隔离工程测试',ageBand:'ADULT',consentStatus:'ADULT_ACCEPTED',onboarded:true}}}});
  const questionText='解 x²-5x+6=0。';
  const problem=await db.problem.create({data:{userId:user.id,subject:'MATH',gradeBand:'HIGH_SCHOOL',questionText,imageIds:[]}});
  const revision=await db.problemRevision.create({data:{problemId:problem.id,questionText,imageIds:[],revisionNumber:1,confirmedAt:new Date()}});
  const attempt=await db.attempt.create({data:{userId:user.id,problemId:problem.id,problemRevisionId:revision.id,rawProcess:'M8 synthetic fixture',attemptStatus:'ATTEMPTED',stuckReasons:[],steps:{create:[{order:1,text:'a=1,b=-5,c=6'},{order:2,text:'Δ=25+24=49'},{order:3,text:'x=(5±7)/2，所以x=6或-1'}]}}});
  const session=await db.diagnosisSession.create({data:{userId:user.id,attemptId:attempt.id,isDemo:true,modelRoute:'M8_SYNTHETIC_ONLY'}});
  const operation=randomUUID();
  const initial=await runTurn(user.id,session.id,operation,{action:'INITIAL',content:''},()=>new OverclaimingFixture());
  return {userId:user.id,id:session.id,operation,initial};
}
afterAll(async()=>{
  const dir=`.local/m8-service/${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}`;
  await mkdir(dir,{recursive:true});await writeFile(`${dir}/result.json`,JSON.stringify({mode:'POSTGRES_SYNTHETIC_SERVICE',networkRequests:0,evidence},null,2));
  await db.$disconnect();
});
describe('M8 trust/help persisted through PostgreSQL services',()=>{
  it('downgrades causal certainty, records content help and shares a propagated root idempotently',async()=>{
    const f=await fixture();
    expect(f.initial.findings.find(v=>v.findingKey==='candidate')).toMatchObject({status:'HYPOTHESIS',verificationNeeded:true,trust:{kind:'HYPOTHESIS'}});
    expect(f.initial.findings.find(v=>v.findingKey==='downstream')?.trust?.rootCause).toMatchObject({role:'PROPAGATED',candidateRootId:'candidate'});
    expect(f.initial.rootCauseSummary).toMatchObject({candidateRoots:1,propagatedFindings:1});
    expect(f.initial.rootCauseSummary).not.toHaveProperty('confirmedRoots');
    expect(f.initial.messages.at(-1)?.assistance).toMatchObject({status:'DETECTED',reviewRequired:true});
    expect(f.initial.messages.at(-1)?.assistance?.effectiveLevel).toBeGreaterThanOrEqual(2);
    const before=await getSession(f.userId,f.id);expect(before.findings.every(v=>v.trust!==null)).toBe(true);
    const forbidden=vi.fn(()=>{throw new Error('cached operation must not call a gateway');});
    const cached=await runTurn(f.userId,f.id,f.operation,{action:'INITIAL',content:''},forbidden);
    expect(forbidden).not.toHaveBeenCalled();expect(cached.messages).toHaveLength(before.messages.length);
    evidence.push({case:'PERSISTED_TRUST_AND_IDEMPOTENCY',sessionId:f.id,rootCount:1,paidRequests:0});
  });
  it('reads legacy metadata as pending without rewriting historical rows',async()=>{
    const f=await fixture();const row=await getSession(f.userId,f.id);const target=row.findings[0];
    await db.diagnosisFinding.update({where:{id:target.id},data:{trust:Prisma.DbNull,status:'VERIFIED',verificationNeeded:false,primary:true}});
    const dto=sessionDTO(await getSession(f.userId,f.id));
    expect(dto.findings.find(v=>v.id===target.id)).toMatchObject({status:'UNRESOLVED',verificationNeeded:true,trust:{kind:'INCONCLUSIVE'}});
    expect(dto.title).toBe(row.attempt.revision.questionText);
    expect((await db.diagnosisFinding.findUniqueOrThrow({where:{id:target.id}})).status).toBe('VERIFIED');
    evidence.push({case:'LEGACY_PENDING_NO_BACKFILL',sessionId:f.id});
  });
  it('uses per-new-question provenance, monotone hint events and unknown legacy help',async()=>{
    const f=await fixture();await runTurn(f.userId,f.id,randomUUID(),{action:'FINISH',content:''},()=>{throw new Error('local finish must not call any model');});
    const set=await createPractice(f.userId,f.id,randomUUID());
    const rows=await db.practiceItem.findMany({where:{setId:set.id},orderBy:{order:'asc'}});
    const answer=(i:number)=>String((rows[i].answerSpec as {value:number}).value);
    const independent=await submitPractice(f.userId,rows[0].id,answer(0),randomUUID());
    expect(independent).toMatchObject({correctness:'CORRECT',independence:'INDEPENDENT',masteryState:'PASSED_CURRENT_PROBE'});
    await useHint(f.userId,rows[1].id);const event=await db.practiceItem.findUniqueOrThrow({where:{id:rows[1].id}});
    await useHint(f.userId,rows[1].id);
    expect((await db.practiceItem.findUniqueOrThrow({where:{id:rows[1].id}})).hintUsedAt).toEqual(event.hintUsedAt);
    // Fault injection touches only this test's fresh item. A missing boolean cannot erase its timestamp.
    await db.practiceItem.update({where:{id:rows[1].id},data:{hintUsed:false}});
    const helped=await submitPractice(f.userId,rows[1].id,answer(1),randomUUID());
    expect(helped.independence).toBe('ASSISTED');expect(helped.masteryState).toBe('NOT_ENOUGH_EVIDENCE');
    await db.practiceItem.update({where:{id:rows[2].id},data:{assistance:Prisma.DbNull}});
    const unknown=await submitPractice(f.userId,rows[2].id,answer(2),randomUUID());
    expect(unknown).toMatchObject({correctness:'CORRECT',assistance:'UNKNOWN',independence:'UNKNOWN',masteryState:'NOT_ENOUGH_EVIDENCE'});
    const historical=await db.practiceSubmission.findUniqueOrThrow({where:{itemId:rows[0].id}});
    expect(submissionDTO({...historical,verifierDetails:null})).toMatchObject({independence:'UNKNOWN',masteryState:'NOT_ENOUGH_EVIDENCE'});
    evidence.push({case:'PER_QUESTION_INDEPENDENCE_AND_HINT_TIMESTAMP',sessionId:f.id,setId:set.id,results:[independent.independence,helped.independence,unknown.independence]});
  });
});
