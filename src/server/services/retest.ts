import 'server-only';
import {db} from '@/lib/db';
import {AppError} from '@/server/security/http';
import {atomicMutation} from './idempotency';
import {getPractice,practiceDTO} from './queries';
import {PRACTICE_BANK} from '@/server/domain/practice-bank';
import type {Prisma} from '@/generated/prisma/client';
import {knownNoAssistance} from '@/server/domain/assistance-review';
export async function createRetest(userId:string,setId:string,key:string){
  await getPractice(userId,setId);
  const id=await atomicMutation(userId,'retest:'+setId,key,{},async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${setId+':retest'}))`;
    const parent=await tx.practiceSet.findFirst({where:{id:setId,userId,deletedAt:null},include:{items:{include:{submission:true}},findings:true,review:true}});
    if(!parent)throw new AppError('NOT_FOUND','没有找到训练。',404);
    if(!['COMPLETED','PENDING_REVIEW'].includes(parent.status))throw new AppError('INVALID_STATE_TRANSITION','请先完成本组作答，再开始新题复测。',409);
    const existing=await tx.practiceSet.findFirst({where:{retestOfId:setId,userId,deletedAt:null}});if(existing)return existing.id;
    const used=await tx.practiceItem.findMany({where:{set:{userId,sessionId:parent.sessionId}},select:{seedId:true}});
    const taken=new Set(used.map(i=>i.seedId));const bank=PRACTICE_BANK.filter(i=>!taken.has(i.id)).slice(0,3);
    if(bank.length<3)throw new AppError('PRACTICE_NOT_VERIFIABLE','本次诊断可用的新题已经做完，暂不生成未经核验的题目。',422);
    const delayed=parent.review?.dueAt&&parent.review.dueAt<=new Date();
    const next=await tx.practiceSet.create({data:{userId,sessionId:parent.sessionId,retestOfId:setId,title:delayed?'判别式与负号运算 · 延迟新题复测':'判别式与负号运算 · 即时新题练习',source:'ORIGINAL_RULE_CHECKED',isDemo:parent.isDemo,validatedAt:new Date(),findings:{create:parent.findings.map(f=>({findingId:f.findingId}))},items:{create:bank.map((item,i)=>({order:i+1,seedId:item.id,tier:item.tier,questionText:item.questionText,answerSpec:item.answerSpec as Prisma.InputJsonObject,hint:item.hint,assistance:knownNoAssistance() as unknown as Prisma.InputJsonObject}))}}});
    if(parent.review)await tx.reviewTask.update({where:{id:parent.review.id},data:{status:'IN_PROGRESS'}});
    return next.id;
  });return practiceDTO(await getPractice(userId,id));
}
export async function syncRetestReview(userId:string,itemId:string){
  const item=await db.practiceItem.findFirst({where:{id:itemId,set:{userId,deletedAt:null}},include:{set:true}});
  const set=item?.set;if(set?.retestOfId&&['COMPLETED','PENDING_REVIEW'].includes(set.status))await db.reviewTask.updateMany({where:{setId:set.retestOfId,userId},data:{status:set.status==='COMPLETED'?'COMPLETED':'PENDING_REVIEW',completedAt:set.status==='COMPLETED'?new Date():null}});
}
