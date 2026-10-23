import 'server-only';
import {NextRequest} from 'next/server';
import {z} from 'zod';
import {db} from '@/lib/db';
import {requireUser,currentUser,meDTO,issueSession,revokeSession,hashPassword,verifyPassword,safeEqual} from '@/server/auth/session';
import {AppError,body,rateLimit,idempotencyKey} from '@/server/security/http';
import {registerSchema,loginSchema,profileSchema,problemSchema,confirmSchema,attemptSchema,turnSchema} from '@/server/security/validators';
import {createProblem,ownProblem,confirmProblem,createAttempt,uploadImage,recognizeProblem} from './problems';
import {getSession,getPractice,sessionDTO,practiceDTO,practiceSummary,listSessions,sessionInclude} from './queries';
import {startDiagnosis,runTurn} from './diagnosis';
import {createPractice,useHint as requestPracticeHint,submitPractice} from './practice';
import {createRetest,syncRetestReview} from './retest';

export async function api(req:NextRequest,path:string[],requestId:string){
  const route=path.join('/');const method=req.method;const id=path[1];
  if(method==='GET'&&route==='health')return {status:'ok',aiMode:process.env.AI_MODE==='live'?'live':'mock'};
  if(method==='POST'&&route==='auth/register'){
    const v=await body(req,registerSchema);
    if(v.ageBand!=='ADULT')throw new AppError('AGE_ACCESS_RESTRICTED','当前封闭试测仅接受年满 18 周岁的参与者，监护人验证机制尚未开放。',403);
    if(process.env.ENABLE_SIGNUP!=='true')throw new AppError('FORBIDDEN','当前尚未开放注册。',403);
    const invite=process.env.INVITE_CODE??'';if(!invite||!safeEqual(v.inviteCode,invite))throw new AppError('FORBIDDEN','邀请码不正确。',403);
    await rateLimit('register:local',process.env.NODE_ENV==='production'?8:30,3600_000);
    if(await db.user.findUnique({where:{email:v.email}}))throw new AppError('INVALID_INPUT','暂时无法注册，请检查资料或尝试登录。',409);
    const user=await db.user.create({data:{email:v.email,passwordHash:await hashPassword(v.password),profile:{create:{displayName:v.displayName??'学习者',ageBand:v.ageBand,consentStatus:'TERMS_PRIVACY_V1_ACCEPTED'}}},include:{profile:true}});
    await issueSession(user.id);return meDTO(user);
  }
  if(method==='POST'&&route==='auth/login'){
    const v=await body(req,loginSchema);await rateLimit('login:global',100,60_000);await rateLimit('login:'+v.email,10,15*60_000);
    const u=await db.user.findUnique({where:{email:v.email},include:{profile:true}});
    const valid=u&&!u.deletedAt&&u.status==='ACTIVE'&&await verifyPassword(u.passwordHash,v.password);
    if(!valid)throw new AppError('UNAUTHORIZED','邮箱或密码不正确。',401);
    if(u.profile?.ageBand!=='ADULT')throw new AppError('AGE_ACCESS_RESTRICTED','当前账号不满足封闭试测条件。',403);
    await issueSession(u.id);return meDTO(u);
  }
  if(method==='POST'&&route==='auth/logout'){await revokeSession();return {loggedOut:true};}
  const user=await requireUser();const userId=user.id;
  await rateLimit('requests:'+userId,240);
  if(method==='GET'&&route==='me')return meDTO(user);
  if(method==='PATCH'&&route==='me'){const v=await body(req,profileSchema);await db.userProfile.update({where:{userId},data:v});return meDTO((await currentUser())!);}
  if(method==='GET'&&route==='dashboard'){
    const recent=await listSessions(userId,new URLSearchParams());
    const [diagnoses,pendingPractice,completedPractice]=await Promise.all([db.diagnosisSession.count({where:{userId,deletedAt:null}}),db.practiceSet.count({where:{userId,deletedAt:null,status:{in:['NOT_STARTED','IN_PROGRESS','PENDING_REVIEW']}}}),db.practiceSet.count({where:{userId,deletedAt:null,status:'COMPLETED'}})]);
    return {stats:{diagnoses,pendingPractice,completedPractice},recent:recent.items.slice(0,5),focus:recent.items.find(s=>!['CANCELED'].includes(s.status)&&s.findingStatus!=='REFUTED')??null};
  }
  if(method==='POST'&&route==='uploads')return uploadImage(req,userId);
  if(method==='GET'&&path[0]==='uploads'&&path.length===2){const u=await db.upload.findFirst({where:{id,userId,deletedAt:null}});if(!u)throw new AppError('NOT_FOUND','图片不存在。',404);return new Response(new Uint8Array(u.bytes),{headers:{'Content-Type':u.mimeType,'Cache-Control':'private, no-store','Content-Disposition':'inline; filename="question.webp"','X-Content-Type-Options':'nosniff'}});}
  if(method==='POST'&&route==='problems')return createProblem(userId,await body(req,problemSchema));
  if(path[0]==='problems'&&path.length>=2){
    if(method==='GET'&&path.length===2){const p=await ownProblem(userId,id);return {...p,confirmedRevisionId:p.currentRevisionId};}
    if(method==='POST'&&path[2]==='confirm'){const v=await body(req,confirmSchema);return confirmProblem(userId,id,v.questionText);}
    if(method==='POST'&&path[2]==='recognize')return recognizeProblem(userId,id);
  }
  if(method==='POST'&&route==='attempts')return createAttempt(userId,await body(req,attemptSchema));
  if(method==='POST'&&route==='diagnoses'){const v=await body(req,z.object({attemptId:z.string().max(100)}).strict());return startDiagnosis(userId,v.attemptId,idempotencyKey(req));}
  if(method==='GET'&&(route==='diagnoses'||route==='records'))return listSessions(userId,req.nextUrl.searchParams);
  if(path[0]==='diagnoses'&&path.length>=2){
    if(method==='GET'&&(path.length===2||path[2]==='report'))return sessionDTO(await getSession(userId,id));
    if(method==='POST'&&path[2]==='turns'){const v=await body(req,turnSchema);return runTurn(userId,id,idempotencyKey(req),v);}
    if(method==='POST'&&path[2]==='finish')return runTurn(userId,id,'finish_'+id,{content:'',action:'FINISH'});
  }
  if(method==='POST'&&route==='practice-sets'){const v=await body(req,z.object({sessionId:z.string().max(100)}).strict());return createPractice(userId,v.sessionId,idempotencyKey(req));}
  if(method==='GET'&&route==='practice-sets'){
    const items=await db.practiceSet.findMany({where:{userId,deletedAt:null,session:{deletedAt:null}},include:{review:true,items:{include:{submission:true}}},orderBy:{createdAt:'desc'},take:100});return {items:items.map(practiceSummary),nextCursor:null};
  }
  if(method==='GET'&&path[0]==='practice-sets'&&path.length===2)return practiceDTO(await getPractice(userId,id));
  if(method==='POST'&&path[0]==='practice-sets'&&path[2]==='retest')return createRetest(userId,id,idempotencyKey(req));
  if(method==='POST'&&path[0]==='practice-items'){
    if(path[2]==='hints')return requestPracticeHint(userId,id);
    if(path[2]==='submissions'){const v=await body(req,z.object({answerText:z.string().trim().min(1).max(4000)}).strict());const submission=await submitPractice(userId,id,v.answerText,idempotencyKey(req));await syncRetestReview(userId,id);return submission;}
  }
  if(method==='POST'&&route==='feedback'){
    const v=await body(req,z.object({sessionId:z.string().max(100),type:z.enum(['ACCURATE','INACCURATE','UNCERTAIN']),note:z.string().max(1000).optional()}).strict());await getSession(userId,v.sessionId);
    const f=await db.userFeedback.create({data:{userId,...v}});return {id:f.id};
  }
  if(path[0]==='records'&&path.length===2){
    if(method==='GET')return sessionDTO(await getSession(userId,id));
    if(method==='DELETE'){
      await body(req,z.object({confirmation:z.literal('DELETE')}).strict());const s=await getSession(userId,id);const at=new Date();
      if(s.lockUntil&&s.lockUntil>at)throw new AppError('SESSION_BUSY','请等待当前分析结束后再删除。',409);
      await db.$transaction(async tx=>{
        await tx.diagnosisSession.update({where:{id},data:{deletedAt:at}});
        await tx.practiceSet.updateMany({where:{sessionId:id,userId},data:{deletedAt:at}});
        const remaining=await tx.diagnosisSession.count({where:{userId,deletedAt:null,attempt:{problemId:s.attempt.problemId}}});
        if(!remaining){
          await tx.problem.update({where:{id:s.attempt.problemId},data:{deletedAt:at}});
          for(const imageId of s.attempt.revision.imageIds){
            const referenced=await tx.problem.count({where:{userId,deletedAt:null,imageIds:{has:imageId}}});
            if(!referenced)await tx.upload.updateMany({where:{id:imageId,userId},data:{deletedAt:at}});
          }
        }
        await tx.auditEvent.create({data:{actorId:userId,action:'SOFT_DELETE_RECORD',subjectType:'DiagnosisSession',subjectId:id,requestId}});
      });return {status:'HIDDEN',message:'记录及关联训练和图片已从查询中移除。物理数据与备份清理仍待管理员处理。'};
    }
  }
  if(method==='POST'&&route==='me/export'){
    await rateLimit('export:'+userId,5,3600_000);
    const sessions=await db.diagnosisSession.findMany({where:{userId,deletedAt:null},include:sessionInclude,orderBy:{createdAt:'desc'}});
    const records=sessions.map(s=>({...sessionDTO(s),practiceEvidence:s.practices.map(practiceDTO)}));
    const feedback=await db.userFeedback.findMany({where:{userId,session:{deletedAt:null}},select:{sessionId:true,type:true,note:true,createdAt:true}});
    return {exportedAt:new Date().toISOString(),profile:meDTO(user),records,feedback,warning:'不包含原始图片文件；可从记录详情单独访问。标准答案和安全凭证不在导出内容中。'};
  }
  if(method==='DELETE'&&route==='me/data'){
    await body(req,z.object({confirmation:z.literal('DELETE_ALL')}).strict());const request=await db.deletionRequest.create({data:{userId}});return {id:request.id,status:'REQUESTED',message:'删除申请已登记，需试测管理员完成物理清理和备份过期处理。当前数据尚未彻底删除。'};
  }
  throw new AppError('NOT_FOUND','没有找到这个接口。',404);
}
