import 'server-only';
import {db} from '@/lib/db';
import {AppError} from '@/server/security/http';
import {atomicMutation} from './idempotency';
import {getSession,getPractice,practiceDTO,submissionDTO} from './queries';
import {selectPracticeItems} from '@/server/domain/practice-bank';
import {answerSpecSchema,evaluatePractice} from '@/server/domain/practice-evaluation';
import type {FindingCategory} from '@/server/ai/schemas/diagnosis';
import type {Prisma} from '@/generated/prisma/client';
import {isDemoQuadratic,inspectDemoSteps} from '@/server/domain/math-verifier';
import {knownNoAssistance,mergeAssistanceReviews,recordedPracticeAssistance,reviewAssistance} from '@/server/domain/assistance-review';
export async function createPractice(userId:string,sessionId:string,key:string){
  const s=await getSession(userId,sessionId);
  if(!['REPORT_READY','INCONCLUSIVE'].includes(s.status))throw new AppError('INVALID_STATE_TRANSITION','请先完成或结束诊断，再开始训练。',409);
  const finding=s.findings.find(f=>['EXECUTION','KNOWLEDGE','EXPRESSION'].includes(f.category)&&f.status!=='REFUTED');
  // The observed input, rather than model wording, decides whether this bank applies.
  // An unresolved cause can still use a probe when the original arithmetic discrepancy is observable.
  const observed=inspectDemoSteps(s.attempt.steps);
  if(!finding||s.attempt.problem.subject!=='MATH'||!isDemoQuadratic(s.attempt.revision.questionText)||!observed.wrongDiscriminant)throw new AppError('PRACTICE_NOT_VERIFIABLE','这类题暂时没有经过规则校验的训练，请保留记录等待确认。',422);
  const bank=selectPracticeItems(finding.category as FindingCategory);
  if(!bank.length)throw new AppError('PRACTICE_NOT_VERIFIABLE','暂无可验证训练。',422);
  const id=await atomicMutation(userId,'practice',key,{sessionId},async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${sessionId+':practice'}))`;
    const existing=await tx.practiceSet.findFirst({where:{sessionId,userId,deletedAt:null}});if(existing)return existing.id;
    const p=await tx.practiceSet.create({data:{userId,sessionId,title:'判别式与负号运算 · 本次独立验证',source:'ORIGINAL_RULE_CHECKED',isDemo:s.isDemo,validatedAt:new Date(),findings:{create:{findingId:finding.id}},items:{create:bank.map((item,i)=>({order:i+1,seedId:item.id,tier:item.tier,questionText:item.questionText,answerSpec:item.answerSpec as Prisma.InputJsonObject,hint:item.hint,assistance:knownNoAssistance() as unknown as Prisma.InputJsonObject}))}}});return p.id;
  });return practiceDTO(await getPractice(userId,id));
}
export async function useHint(userId:string,itemId:string){
  return db.$transaction(async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${itemId}))`;
    const item=await tx.practiceItem.findFirst({where:{id:itemId,set:{userId,deletedAt:null,session:{deletedAt:null}}},include:{submission:true}});if(!item)throw new AppError('NOT_FOUND','没有找到训练题。',404);
    if(item.submission)throw new AppError('INVALID_STATE_TRANSITION','本题已提交，请查看结果或开始下一题。',409);
    const review=mergeAssistanceReviews(item.assistance,reviewAssistance({studentFacingText:item.hint,declaredHintLevel:1,requestedAction:'HINT',subject:'MATH',questionText:item.questionText}));
    // Both fields are monotone. Repeated requests cannot clear the first event.
    await tx.practiceItem.update({where:{id:itemId},data:{hintUsed:true,hintUsedAt:item.hintUsedAt??new Date(),assistance:review as unknown as Prisma.InputJsonObject}});
    const evidence=recordedPracticeAssistance({...item,hintUsed:true,hintUsedAt:item.hintUsedAt??new Date(),assistance:review});
    return {hint:item.hint,assistance:evidence.assistance};
  });
}
export async function submitPractice(userId:string,itemId:string,answerText:string,key:string){
  const owned=await db.practiceItem.findFirst({where:{id:itemId,set:{userId,deletedAt:null,session:{deletedAt:null}}}});if(!owned)throw new AppError('NOT_FOUND','没有找到训练题。',404);
  const id=await atomicMutation(userId,'submission:'+itemId,key,{answerText},async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${itemId}))`;
    const item=await tx.practiceItem.findFirst({where:{id:itemId,set:{userId,deletedAt:null}},include:{submission:true}});if(!item)throw new AppError('NOT_FOUND','没有找到训练题。',404);
    if(item.submission){if(item.submission.answerText===answerText)return item.submission.id;throw new AppError('INVALID_STATE_TRANSITION','本题已提交，原始作答已保存。',409);}
    const evidence=recordedPracticeAssistance(item);
    const result=evaluatePractice({answerText,answerSpec:answerSpecSchema.parse(item.answerSpec),assistance:evidence.assistance,assistanceReasons:evidence.reasons});
    const verifierDetails={schemaVersion:'1.0',verifiedBy:result.verifiedBy,independence:result.independence,independenceReasons:result.independenceReasons,assistanceReview:evidence.review};
    const submission=await tx.practiceSubmission.create({data:{itemId,userId,answerText,correctness:result.correctness,assistance:result.assistance,evaluationMethod:result.evaluationMethod,masteryState:result.masteryState,feedback:result.feedback,verifierDetails:verifierDetails as Prisma.InputJsonObject}});
    const all=await tx.practiceItem.findMany({where:{setId:item.setId},include:{submission:true}});
    const done=all.every(i=>i.submission);const pending=all.some(i=>i.submission?.correctness==='UNKNOWN'||i.submission?.assistance==='UNKNOWN');
    await tx.practiceSet.update({where:{id:item.setId},data:{status:done?(pending?'PENDING_REVIEW':'COMPLETED'):'IN_PROGRESS'}});
    if(done)await tx.reviewTask.upsert({where:{setId:item.setId},create:{setId:item.setId,userId,dueAt:new Date(Date.now()+7*86400_000),status:'PENDING'},update:{}});
    return submission.id;
  });
  const submission=await db.practiceSubmission.findFirst({where:{id,userId}});if(!submission)throw new AppError('NOT_FOUND','没有找到作答。',404);return submissionDTO(submission);
}
