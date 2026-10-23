import 'server-only';
import {randomUUID} from 'node:crypto';
import {db} from '@/lib/db';
import {AppError,hashInput} from '@/server/security/http';
import {atomicMutation} from './idempotency';
import {getSession,sessionDTO,sessionInclude} from './queries';
import {createGateway,GatewayError,type DiagnosisContext} from '@/server/ai/gateway';
import {findingSchema,type DiagnosisTurn} from '@/server/ai/schemas/diagnosis';
import {validateDiagnosisTurn} from '@/server/ai/validate-turn';
import {transitionDiagnosis,stateForAction,type DiagnosisState} from '@/server/domain/diagnosis-fsm';

export async function startDiagnosis(userId:string,attemptId:string,key:string){
  const a=await db.attempt.findFirst({where:{id:attemptId,userId,problem:{deletedAt:null}},include:{revision:true}});if(!a)throw new AppError('NOT_FOUND','没有找到已确认的作答。',404);
  const id=await atomicMutation(userId,'start',key,{attemptId},async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${attemptId}))`;
    const existing=await tx.diagnosisSession.findUnique({where:{attemptId}});if(existing){if(existing.deletedAt)throw new AppError('NOT_FOUND','记录已移除。',404);return existing.id;}
    const dayStart=new Date();dayStart.setUTCHours(0,0,0,0);
    const count=await tx.diagnosisSession.count({where:{userId,createdAt:{gte:dayStart}}});
    if(count>=Number(process.env.MAX_DAILY_DIAGNOSES??30))throw new AppError('QUOTA_EXCEEDED','今天的诊断额度已用完，请明天继续。',429);
    const s=await tx.diagnosisSession.create({data:{userId,attemptId,modelRoute:process.env.AI_MODE==='live'?'aliyun':'mock',isDemo:process.env.AI_MODE!=='live'}});return s.id;
  });
  const s=await getSession(userId,id);
  if(s.status==='INPUT_CONFIRMED'||s.status==='FAILED_RETRYABLE')return runTurn(userId,id,'initial_'+id,{content:'',action:'INITIAL'});
  return sessionDTO(s);
}

type TurnInput={content:string;action:'INITIAL'|'REPLY'|'HINT'|'RETRY'|'FINISH'};
// Injectable only by trusted server callers/tests; API routes always use the default factory.
export async function runTurn(userId:string,id:string,key:string,input:TurnInput,gatewayFactory:typeof createGateway=createGateway){
  await getSession(userId,id);
  const token=randomUUID();const scope='turn:'+id;
  const lease=await db.$transaction(async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
    const s=await tx.diagnosisSession.findFirst({where:{id,userId,deletedAt:null},include:sessionInclude});if(!s)throw new AppError('NOT_FOUND','没有找到诊断。',404);
    let effectiveKey=key;let effective=input;
    if(input.action==='RETRY'){
      const last=await tx.mutationKey.findFirst({where:{userId,scope,status:'RETRYABLE'},orderBy:{createdAt:'desc'}});
      if(last){effectiveKey=last.key;const msg=s.messages.find(m=>m.operationKey===last.key&&m.role==='USER');effective={content:msg?.content??'',action:msg?.kind==='FINISH'?'FINISH':msg?.kind==='HINT'?'HINT':s.turnCount===0?'INITIAL':'REPLY'};}
      else if(s.status!=='FAILED_RETRYABLE')throw new AppError('INVALID_STATE_TRANSITION','当前没有需要重试的回合。',409);
    }
    const old=await tx.mutationKey.findUnique({where:{userId_scope_key:{userId,scope,key:effectiveKey}}});
    if(old&&input.action!=='RETRY'&&old.inputHash!==hashInput(effective))throw new AppError('INVALID_INPUT','相同提交标识不能用于不同内容。',409);
    if(old?.status==='COMPLETED')return {cached:true as const,key:effectiveKey,input:effective,state:s.status as DiagnosisState};
    if(['REPORT_READY','INCONCLUSIVE','CANCELED'].includes(s.status))throw new AppError('INVALID_STATE_TRANSITION','本次诊断已结束，请开始新的诊断。',409);
    if(s.lockUntil&&s.lockUntil>new Date())throw new AppError('SESSION_BUSY','正在分析上一条回复，请稍候。',409);
    const limit=Number(process.env.MAX_DIAGNOSIS_TURNS??6);
    if(s.turnCount>=limit)effective={...effective,action:'FINISH'};
    let from=s.status as DiagnosisState;
    if(['ANALYZING','EVALUATING'].includes(from))from='FAILED_RETRYABLE';
    if(from==='NEEDS_INPUT')from='QUESTIONING';
    const next=transitionDiagnosis(from,s.turnCount===0?'ANALYZING':'EVALUATING');
    await tx.diagnosisSession.update({where:{id},data:{status:next,lockToken:token,lockUntil:new Date(Date.now()+90_000)}});
    if(!old)await tx.mutationKey.create({data:{userId,scope,key:effectiveKey,inputHash:hashInput(input),resourceId:id}});
    else await tx.mutationKey.update({where:{id:old.id},data:{status:'PENDING'}});
    if(effective.action!=='INITIAL'&&!s.messages.some(m=>m.operationKey===effectiveKey&&m.role==='USER')){
      const content=effective.action==='HINT'?'给我一点提示':effective.action==='FINISH'?'结束本次诊断，保留当前证据。':effective.content;
      await tx.diagnosisMessage.create({data:{sessionId:id,role:'USER',content,kind:effective.action,sequence:(s.messages.at(-1)?.sequence??0)+1,operationKey:effectiveKey,referencedStepIds:[]}});
    }
    return {cached:false as const,key:effectiveKey,input:effective,state:next};
  });
  if(lease.cached)return sessionDTO(await getSession(userId,id));
  let gateway:ReturnType<typeof createGateway>|null=null;
  try{
    const s=await getSession(userId,id);
    const data=sessionDTO(s);
    const context:DiagnosisContext={questionId:s.attempt.revision.id,questionText:s.attempt.revision.questionText,subject:s.attempt.problem.subject,gradeBand:s.attempt.problem.gradeBand,steps:s.attempt.steps.map(v=>({id:v.id,text:v.text})),messages:s.messages.slice(-12).map(m=>({id:m.id,role:m.role as 'USER'|'ASSISTANT',content:m.content})),findings:data.findings.map(({findingKey,category,statement,status,supportingEvidence,contradictingEvidence,verificationNeeded})=>findingSchema.parse({findingKey,category,statement,status,supportingEvidence,contradictingEvidence,verificationNeeded})),turnCount:s.turnCount,hintLevel:s.hintLevel as 0|1|2|3,requestedAction:lease.input.action==='HINT'?'HINT':lease.input.action==='FINISH'?'FINISH':'REPLY'};
    let turn:DiagnosisTurn;
    if(lease.input.action==='FINISH'){
      turn={schemaVersion:'1.0',action:'MARK_INCONCLUSIVE',studentFacingText:'本次诊断已保存。已确认：保留你提交的步骤与对话证据。待确认：仍不足以确定错误原因；可以稍后用新题验证。',referencedStepIds:[],findings:context.findings.map(f=>({...f,status:f.status==='REFUTED'?'REFUTED':'UNRESOLVED',verificationNeeded:f.status!=='REFUTED'})),followUpQuestion:null,hintLevel:context.hintLevel,safetyFlags:['STUDENT_ENDED_OR_TURN_LIMIT']};
    }else{gateway=gatewayFactory();turn=validateDiagnosisTurn(await gateway.createDiagnosisTurn(context),context);}
    const finalState=transitionDiagnosis(lease.state,stateForAction(turn.action));
    await db.$transaction(async tx=>{
      const locked=await tx.diagnosisSession.findFirst({where:{id,userId,lockToken:token,deletedAt:null}});if(!locked)throw new AppError('SESSION_BUSY','会话状态已更新，请刷新。',409);
      // A new decision must not leave an omitted older finding marked as primary.
      await tx.diagnosisFinding.updateMany({where:{sessionId:id,primary:true},data:{primary:false}});
      if(['REPORT_READY','INCONCLUSIVE'].includes(finalState)){
        // Preserve prior evidence, but an omitted final hypothesis is not a supported conclusion.
        await tx.diagnosisFinding.updateMany({where:{sessionId:id,findingKey:{notIn:turn.findings.map(f=>f.findingKey)},status:{not:'REFUTED'}},data:{status:'UNRESOLVED',verificationNeeded:true,primary:false}});
      }
      for(const [index,f] of turn.findings.entries()){
        const finding=await tx.diagnosisFinding.upsert({where:{sessionId_findingKey:{sessionId:id,findingKey:f.findingKey}},create:{sessionId:id,findingKey:f.findingKey,category:f.category,statement:f.statement,status:f.status,verificationNeeded:f.verificationNeeded,primary:index===0&&['SUPPORTED','VERIFIED'].includes(f.status)},update:{category:f.category,statement:f.statement,status:f.status,verificationNeeded:f.verificationNeeded,primary:index===0&&['SUPPORTED','VERIFIED'].includes(f.status)}});
        for(const [polarity,evidence] of [['SUPPORTING',f.supportingEvidence],['CONTRADICTING',f.contradictingEvidence]] as const){for(const e of evidence)await tx.findingEvidence.upsert({where:{findingId_sourceType_sourceId_polarity:{findingId:finding.id,sourceType:e.kind,sourceId:e.sourceId,polarity}},create:{findingId:finding.id,sourceType:e.kind,sourceId:e.sourceId,polarity,excerpt:e.excerpt},update:{excerpt:e.excerpt}});}
      }
      const last=await tx.diagnosisMessage.aggregate({where:{sessionId:id},_max:{sequence:true}});
      await tx.diagnosisMessage.create({data:{sessionId:id,role:'ASSISTANT',content:turn.studentFacingText,kind:turn.action,sequence:(last._max.sequence??0)+1,referencedStepIds:turn.referencedStepIds,operationKey:lease.key}});
      const done=['REPORT_READY','INCONCLUSIVE'].includes(finalState);
      await tx.diagnosisSession.update({where:{id},data:{status:finalState,turnCount:{increment:1},hintLevel:Math.max(s.hintLevel,turn.hintLevel),lockToken:null,lockUntil:null,...(done?{finishedAt:new Date(),reportVersion:{increment:1}}:{})}});
      await tx.mutationKey.update({where:{userId_scope_key:{userId,scope,key:lease.key}},data:{status:'COMPLETED'}});
      const m=gateway?.lastInvocation;if(m)await tx.modelInvocation.create({data:{userId,sessionId:id,provider:m.provider,model:m.model,promptVersion:m.promptVersion,inputTokens:m.inputTokens,outputTokens:m.outputTokens,latencyMs:m.latencyMs,status:m.status,errorClass:m.errorClass}});
    });
    return sessionDTO(await getSession(userId,id));
  }catch(e){
    await db.$transaction(async tx=>{
      await tx.diagnosisSession.updateMany({where:{id,userId,lockToken:token},data:{status:'FAILED_RETRYABLE',lockToken:null,lockUntil:null}});
      await tx.mutationKey.updateMany({where:{userId,scope,key:lease.key,status:'PENDING'},data:{status:'RETRYABLE'}});
      const m=gateway?.lastInvocation;if(m)await tx.modelInvocation.create({data:{userId,sessionId:id,provider:m.provider,model:m.model,promptVersion:m.promptVersion,inputTokens:m.inputTokens,outputTokens:m.outputTokens,latencyMs:m.latencyMs,status:'ERROR',errorClass:e instanceof GatewayError?e.code:'AI_INVALID_OUTPUT'}});
    });
    if(e instanceof AppError)throw e;
    throw new AppError(e instanceof GatewayError?e.code:'AI_INVALID_OUTPUT','这轮分析暂时不可用，你的输入已保存。请重试或结束并保存当前记录。',503);
  }
}
