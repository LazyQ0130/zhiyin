import 'server-only';
import {NextRequest} from 'next/server';
import sharp from 'sharp';
import {db} from '@/lib/db';
import {AppError,readBounded,rateLimit} from '@/server/security/http';
import {createGateway,GatewayError} from '@/server/ai/gateway';
import {z} from 'zod';
import {problemSchema,attemptSchema} from '@/server/security/validators';
export async function createProblem(userId:string,input:z.infer<typeof problemSchema>){
  if(input.imageIds.length){const count=await db.upload.count({where:{id:{in:input.imageIds},userId,deletedAt:null}});if(count!==new Set(input.imageIds).size)throw new AppError('NOT_FOUND','图片不存在或无权访问。',404);}
  const p=await db.problem.create({data:{userId,...input,sourceType:input.imageIds.length?'IMAGE':'TEXT'}});
  return {...p,confirmedRevisionId:p.currentRevisionId};
}
export async function ownProblem(userId:string,id:string){const p=await db.problem.findFirst({where:{id,userId,deletedAt:null}});if(!p)throw new AppError('NOT_FOUND','没有找到题目。',404);return p;}
export async function confirmProblem(userId:string,id:string,questionText:string){
  await ownProblem(userId,id);
  return db.$transaction(async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
    const p=await tx.problem.findFirst({where:{id,userId,deletedAt:null},include:{revisions:{orderBy:{revisionNumber:'desc'},take:1}}});if(!p)throw new AppError('NOT_FOUND','没有找到题目。',404);
    const previous=p.revisions[0];if(previous?.questionText===questionText)return {revisionId:previous.id,problemId:id};
    const rev=await tx.problemRevision.create({data:{problemId:id,questionText,imageIds:p.imageIds,confirmedAt:new Date(),revisionNumber:(previous?.revisionNumber??0)+1}});
    await tx.problem.update({where:{id},data:{currentRevisionId:rev.id,questionText}});
    return {revisionId:rev.id,problemId:id};
  });
}
export async function createAttempt(userId:string,input:z.infer<typeof attemptSchema>){
  const p=await ownProblem(userId,input.problemId);
  const rev=await db.problemRevision.findFirst({where:{id:input.revisionId,problemId:p.id}});
  if(!rev||!p.currentRevisionId)throw new AppError('UNCONFIRMED_PROBLEM','请先确认题目，再开始诊断。');
  const parts=input.notAttempted?[]:input.rawProcess.split(/\r?\n|；|;/).map(v=>v.trim()).filter(Boolean);
  if(parts.length>80)throw new AppError('INVALID_INPUT','步骤过多，请保留本题的关键过程。');
  const a=await db.attempt.create({data:{userId,problemId:p.id,problemRevisionId:rev.id,rawProcess:input.notAttempted?'':input.rawProcess,stuckReasons:input.stuckReasons,attemptStatus:input.notAttempted?'NOT_ATTEMPTED':'ATTEMPTED',steps:{create:parts.map((text,i)=>({order:i+1,text}))}}});return {id:a.id};
}
export async function uploadImage(req:NextRequest,userId:string){
  await rateLimit('upload:'+userId,20,3600_000);
  if(!req.headers.get('content-type')?.startsWith('multipart/form-data;'))throw new AppError('UNSUPPORTED_FILE','请选择 JPG、PNG 或 WEBP 图片。',415);
  const raw=await readBounded(req,10*1024*1024+64*1024);
  const form=await new Request('http://localhost',{method:'POST',headers:{'Content-Type':req.headers.get('content-type')!},body:raw}).formData();
  const file=form.get('file');if(!(file instanceof File)||file.size===0)throw new AppError('INVALID_INPUT','请选择一张图片。');
  if(file.size>10*1024*1024)throw new AppError('FILE_TOO_LARGE','每张图片最大 10 MiB。',413);
  const bytes=Buffer.from(await file.arrayBuffer());
  const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  const webp=bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
  const allowedType=png?'image/png':jpg?'image/jpeg':webp?'image/webp':null;
  if(!allowedType||file.type!==allowedType)throw new AppError('UNSUPPORTED_FILE','图片内容与格式不符，仅支持 JPG、PNG、WEBP。',415);
  let cleaned:Buffer;try{cleaned=await sharp(bytes,{limitInputPixels:25_000_000,animated:false}).rotate().resize({width:2400,height:2400,fit:'inside',withoutEnlargement:true}).webp({quality:90}).toBuffer();}catch{throw new AppError('UNSUPPORTED_FILE','图片损坏或尺寸过大，请换一张图片。',415);}
  const total=await db.upload.aggregate({where:{userId,deletedAt:null},_sum:{size:true}});if((total._sum.size??0)+cleaned.length>100*1024*1024)throw new AppError('QUOTA_EXCEEDED','已达到本地试测图片存储上限。',429);
  const stored=await db.upload.create({data:{userId,mimeType:'image/webp',bytes:new Uint8Array(cleaned),size:cleaned.length}});return {id:stored.id,mimeType:stored.mimeType,size:stored.size};
}
export async function recognizeProblem(userId:string,id:string){
  const p=await ownProblem(userId,id);if(!p.imageIds.length)throw new AppError('INVALID_INPUT','请先上传题目图片。');
  await rateLimit('recognize:'+userId,30,86400_000);
  const uploads=await db.upload.findMany({where:{id:{in:p.imageIds},userId,deletedAt:null}});
  const gateway=createGateway();
  try{const r=await gateway.recognizeQuestion({images:uploads.map(u=>({dataUrl:`data:${u.mimeType};base64,${Buffer.from(u.bytes).toString('base64')}`}))});return {questionText:r.text,warning:r.warning,isDemo:gateway.mode==='mock'};}
  catch(e){throw new AppError(e instanceof GatewayError?e.code:'AI_UNAVAILABLE','暂时无法识别，请手动输入题目或稍后重试。',503);}
  finally{const m=gateway.lastInvocation;if(m)await db.modelInvocation.create({data:{userId,provider:m.provider,model:m.model,promptVersion:m.promptVersion,inputTokens:m.inputTokens,outputTokens:m.outputTokens,latencyMs:m.latencyMs,status:m.status,errorClass:m.errorClass}});}
}
