import 'server-only';
import { randomUUID,createHash } from 'node:crypto';
import { NextRequest,NextResponse } from 'next/server';
import { z } from 'zod';
import {db} from '@/lib/db';
export class AppError extends Error {
  constructor(public code:string,message:string,public status=400){super(message);}
}
export function checkOrigin(req:NextRequest){
  if(['GET','HEAD','OPTIONS'].includes(req.method))return;
  const origin=req.headers.get('origin');
  const allowed=new URL(process.env.APP_URL ?? 'http://127.0.0.1:3000').origin;
  if(origin!==allowed)throw new AppError('FORBIDDEN','请求来源无效，请刷新后重试。',403);
  const fetchSite=req.headers.get('sec-fetch-site');
  if(fetchSite==='cross-site')throw new AppError('FORBIDDEN','请求来源无效。',403);
}
export async function body<T>(req:NextRequest,schema:z.ZodType<T>):Promise<T>{
  if(!req.headers.get('content-type')?.startsWith('application/json'))throw new AppError('INVALID_INPUT','请使用 JSON 提交。',415);
  const raw=await readBounded(req,64*1024);
  try{return schema.parse(JSON.parse(new TextDecoder().decode(raw)));}catch(e){
    if(e instanceof z.ZodError)throw new AppError('INVALID_INPUT',e.issues[0]?.message ?? '请检查输入内容。');
    throw new AppError('INVALID_INPUT','提交内容不是有效 JSON。');
  }
}
export async function readBounded(req:NextRequest,max:number){
  if(Number(req.headers.get('content-length')??0)>max)throw new AppError('FILE_TOO_LARGE','提交内容过大。',413);
  const reader=req.body?.getReader();if(!reader)return new Uint8Array();
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();throw new AppError('FILE_TOO_LARGE','提交内容超过大小限制。',413);}chunks.push(value);}
  const out=new Uint8Array(size);let offset=0;for(const c of chunks){out.set(c,offset);offset+=c.length;}return out;
}
export function hashInput(input:unknown){return createHash('sha256').update(JSON.stringify(input)).digest('hex');}
export function idempotencyKey(req:NextRequest){const key=req.headers.get('idempotency-key');if(!key||!/^[A-Za-z0-9_-]{8,100}$/.test(key))throw new AppError('INVALID_INPUT','缺少有效的提交标识，请刷新后重试。');return key;}
export async function rateLimit(key:string,max:number,windowMs=60_000){
  if(process.env.RATE_LIMIT_ENABLED==='false'&&process.env.NODE_ENV!=='production')return;
  const hashed=createHash('sha256').update(key).digest('hex');
  const rows=await db.$queryRaw<{count:number}[]>`INSERT INTO "RateLimitBucket" ("key","count","resetAt") VALUES (${hashed},1,${new Date(Date.now()+windowMs)}) ON CONFLICT ("key") DO UPDATE SET "count" = CASE WHEN "RateLimitBucket"."resetAt" < NOW() THEN 1 ELSE "RateLimitBucket"."count"+1 END, "resetAt" = CASE WHEN "RateLimitBucket"."resetAt" < NOW() THEN EXCLUDED."resetAt" ELSE "RateLimitBucket"."resetAt" END RETURNING "count"`;
  if(rows[0].count>max)throw new AppError('RATE_LIMITED','操作太频繁，请稍后再试。',429);
}
export async function endpoint(req:NextRequest,run:(requestId:string)=>Promise<unknown>){
  const requestId=randomUUID();
  try{checkOrigin(req);const result=await run(requestId);if(result instanceof Response)return result;return NextResponse.json({data:result,requestId},{headers:{'Cache-Control':'no-store','X-Request-Id':requestId}});}
  catch(e){
    const err=e instanceof AppError?e:new AppError('INTERNAL_ERROR','服务暂时不可用，请稍后重试。',500);
    if(!(e instanceof AppError))console.error(JSON.stringify({requestId,errorClass:e instanceof Error?e.name:'UnknownError'}));
    return NextResponse.json({error:{code:err.code,message:err.message},requestId},{status:err.status,headers:{'Cache-Control':'no-store','X-Request-Id':requestId}});
  }
}
