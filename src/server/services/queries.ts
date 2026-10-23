import 'server-only';
import {db} from '@/lib/db';
import type {Prisma} from '@/generated/prisma/client';
import type {SessionDTO,SessionSummary,PracticeDTO,PracticeSummary,SubmissionDTO,GradeBand,Subject} from '@/lib/contracts';
import {AppError} from '@/server/security/http';
import {findingTrustSchema} from '@/server/ai/schemas/diagnosis';
import {legacyFindingTrust} from '@/server/ai/evidence-trust';
import {parseAssistanceReview} from '@/server/domain/assistance-review';
export const sessionInclude={attempt:{include:{revision:true,problem:true,steps:{orderBy:{order:'asc' as const}}}},messages:{orderBy:{sequence:'asc' as const}},findings:{include:{evidence:true}},practices:{where:{deletedAt:null},include:{review:true,items:{include:{submission:true}}}}} satisfies Prisma.DiagnosisSessionInclude;
type SessionRow=Prisma.DiagnosisSessionGetPayload<{include:typeof sessionInclude}>;
export const practiceInclude={review:true,items:{orderBy:{order:'asc' as const},include:{submission:true}}} satisfies Prisma.PracticeSetInclude;
type PracticeRow=Prisma.PracticeSetGetPayload<{include:typeof practiceInclude}>;
export function practiceSummary(p:PracticeRow):PracticeSummary{return {id:p.id,sessionId:p.sessionId,status:p.status,title:p.title,createdAt:p.createdAt.toISOString(),completedCount:p.items.filter(i=>i.submission).length,itemCount:p.items.length,isDemo:p.isDemo,retestOfId:p.retestOfId,reviewDueAt:p.review?.dueAt?.toISOString()??null};}
export function submissionDTO(s:Prisma.PracticeSubmissionGetPayload<object>):SubmissionDTO{
  const details=s.verifierDetails&&typeof s.verifierDetails==='object'&&!Array.isArray(s.verifierDetails)?s.verifierDetails:null;
  const review=parseAssistanceReview(details?.assistanceReview);
  const independent=details?.independence==='INDEPENDENT'&&review?.status==='CLEAR'&&review.effectiveLevel===0;
  const assisted=details?.independence==='ASSISTED'||['HINTED','SOLUTION_VIEWED'].includes(s.assistance);
  const independence=independent?'INDEPENDENT':assisted?'ASSISTED':'UNKNOWN';
  return {id:s.id,answerText:s.answerText,correctness:s.correctness,assistance:independence==='UNKNOWN'?'UNKNOWN':s.assistance,evaluationMethod:s.evaluationMethod,masteryState:independence==='UNKNOWN'?'NOT_ENOUGH_EVIDENCE':s.masteryState,feedback:independence==='UNKNOWN'?`${s.correctness==='CORRECT'?'本次数值核验正确':s.correctness==='INCORRECT'?'本次数值与核算结果不一致':'本次作答仍待核验'}；帮助记录不完整，独立性待确认。`:s.feedback,independence,independenceReasons:Array.isArray(details?.independenceReasons)?details.independenceReasons.filter((v):v is string=>typeof v==='string'):['HISTORICAL_HELP_PROVENANCE_UNKNOWN']};
}
export function practiceDTO(p:PracticeRow):PracticeDTO{return {...practiceSummary(p),items:p.items.map(i=>({id:i.id,questionText:i.questionText,tier:i.tier,hintUsed:i.hintUsed,...(i.hintUsed?{hint:i.hint}:{}),...(i.submission?{submission:submissionDTO(i.submission)}:{})}))};}
export function summary(s:SessionRow):SessionSummary{
  const primary=s.findings.find(f=>{const trust=findingTrustSchema.safeParse(f.trust);return f.primary&&trust.success&&['OBSERVATION','VERIFIED'].includes(trust.data.kind)&&trust.data.rootCause.role!=='PROPAGATED';});
  return {id:s.id,status:s.status,createdAt:s.createdAt.toISOString(),subject:s.attempt.problem.subject as Subject,gradeBand:s.attempt.problem.gradeBand as GradeBand,questionText:s.attempt.revision.questionText,title:primary?.statement??s.attempt.revision.questionText,findingStatus:primary?.status??null,practiceSetId:s.practices[0]?.id??null,isDemo:s.isDemo};
}
export function sessionDTO(s:SessionRow):SessionDTO{
  const findings=s.findings.map(f=>{
    const parsed=findingTrustSchema.safeParse(f.trust);const trust=parsed.success?parsed.data:legacyFindingTrust();
    return {id:f.id,findingKey:f.findingKey,category:f.category,statement:!parsed.success&&f.statement?'历史记录保留了步骤与回答线索；当前缺少本版验证信息，具体原因待复核。':f.statement,status:!parsed.success&&f.status!=='REFUTED'?'UNRESOLVED':f.status,verificationNeeded:parsed.success?f.verificationNeeded:true,trust,supportingEvidence:f.evidence.filter(e=>e.polarity==='SUPPORTING').map(e=>({kind:e.sourceType,sourceId:e.sourceId,...(e.excerpt?{excerpt:e.excerpt}:{})})),contradictingEvidence:f.evidence.filter(e=>e.polarity==='CONTRADICTING').map(e=>({kind:e.sourceType,sourceId:e.sourceId,...(e.excerpt?{excerpt:e.excerpt}:{})}))};
  });
  const roots=new Set(findings.filter(f=>f.status!=='REFUTED'&&f.trust.rootCause.role!=='PROPAGATED').flatMap(f=>f.trust.rootCause.candidateRootId?[f.trust.rootCause.candidateRootId]:[]));
  return {...summary(s),imageIds:s.attempt.revision.imageIds,steps:s.attempt.steps.map(p=>({id:p.id,text:p.text,order:p.order})),messages:s.messages.map(m=>{const assistance=parseAssistanceReview(m.assistance);return {id:m.id,role:m.role,content:m.content,referencedStepIds:m.referencedStepIds,...(assistance?{assistance}:{})};}),findings,rootCauseSummary:{candidateRoots:roots.size,propagatedFindings:findings.filter(f=>f.trust.rootCause.role==='PROPAGATED').length,unresolvedRelations:findings.filter(f=>f.trust.rootCause.role==='UNKNOWN').length},turnCount:s.turnCount,hintLevel:s.hintLevel,reportVersion:s.reportVersion,practiceSets:s.practices.map(practiceSummary)};
}
export async function getSession(userId:string,id:string){const s=await db.diagnosisSession.findFirst({where:{id,userId,deletedAt:null},include:sessionInclude});if(!s)throw new AppError('NOT_FOUND','没有找到这条学习记录。',404);return s;}
export async function getPractice(userId:string,id:string){const p=await db.practiceSet.findFirst({where:{id,userId,deletedAt:null,session:{deletedAt:null}},include:practiceInclude});if(!p)throw new AppError('NOT_FOUND','没有找到这组训练。',404);return p;}
export async function listSessions(userId:string,params:URLSearchParams){
  const status=params.get('status');const subject=params.get('subject');const cursor=params.get('cursor');const date=params.get('from');
  const parseDay=(value:string|null)=>{if(!value)return undefined;if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new AppError('INVALID_INPUT','日期格式不正确。');const d=new Date(value+'T00:00:00+08:00');if(Number.isNaN(d.getTime()))throw new AppError('INVALID_INPUT','日期格式不正确。');return d;};
  const from=parseDay(date);const to=parseDay(params.get('to'));if(to)to.setUTCDate(to.getUTCDate()+1);
  if(cursor&&!await db.diagnosisSession.findFirst({where:{id:cursor,userId,deletedAt:null},select:{id:true}}))throw new AppError('NOT_FOUND','分页位置无效。',404);
  const items=await db.diagnosisSession.findMany({where:{userId,deletedAt:null,...(status?{status}:{}),...(subject?{attempt:{problem:{subject}}}:{}),...((from||to)?{createdAt:{...(from?{gte:from}:{}),...(to?{lt:to}:{})}}:{})},include:sessionInclude,orderBy:[{createdAt:'desc'},{id:'desc'}],take:51,...(cursor?{cursor:{id:cursor},skip:1}:{})});
  return {items:items.slice(0,50).map(summary),nextCursor:items.length>50?items[49].id:null};
}
