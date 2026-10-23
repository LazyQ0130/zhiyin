import 'server-only';
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {cookies} from 'next/headers';
import {hash,verify} from '@node-rs/argon2';
import {db} from '@/lib/db';
import {AppError} from '@/server/security/http';
import type {MeDTO} from '@/lib/contracts';
const cookieName='zhiyin_session';
function tokenHash(token:string){const secret=process.env.SESSION_SECRET;if(!secret||secret.length<32||secret.startsWith('replace-'))throw new AppError('INTERNAL_ERROR','服务尚未完成安全配置。',503);return createHmac('sha256',secret).update(token).digest('hex');}
// argon2's documented default algorithm is Argon2id; omit its ambient const enum for isolatedModules.
export const hashPassword=(password:string)=>hash(password,{memoryCost:19456,timeCost:2,parallelism:1});
export const verifyPassword=(encoded:string,password:string)=>verify(encoded,password);
export function safeEqual(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export async function currentUser(){
  const token=(await cookies()).get(cookieName)?.value;
  if(!token||!/^[a-f0-9]{64}$/.test(token))return null;
  const session=await db.session.findUnique({where:{tokenHash:tokenHash(token)},include:{user:{include:{profile:true}}}});
  if(!session||session.revokedAt||session.expiresAt<new Date()||session.user.deletedAt||session.user.status!=='ACTIVE'||session.user.profile?.ageBand!=='ADULT')return null;
  return session.user;
}
export async function requireUser(){const user=await currentUser();if(!user)throw new AppError('UNAUTHORIZED','请先登录。',401);return user;}
export async function issueSession(userId:string){
  const jar=await cookies();const old=jar.get(cookieName)?.value;
  if(old)await db.session.updateMany({where:{tokenHash:tokenHash(old)},data:{revokedAt:new Date()}});
  const token=randomBytes(32).toString('hex');const expiresAt=new Date(Date.now()+7*86400_000);
  await db.session.create({data:{userId,tokenHash:tokenHash(token),expiresAt}});
  const secure=new URL(process.env.APP_URL??'http://127.0.0.1:3000').protocol==='https:';
  jar.set(cookieName,token,{httpOnly:true,secure,sameSite:'lax',path:'/',expires:expiresAt});
}
export async function revokeSession(){const jar=await cookies();const token=jar.get(cookieName)?.value;if(token)await db.session.updateMany({where:{tokenHash:tokenHash(token)},data:{revokedAt:new Date()}});jar.delete(cookieName);}
export function meDTO(user:NonNullable<Awaited<ReturnType<typeof currentUser>>>):MeDTO{
  const p=user.profile!;
  return {user:{id:user.id,email:user.email},profile:{displayName:p.displayName,gradeBand:p.gradeBand as MeDTO['profile']['gradeBand'],preferredSubjects:p.preferredSubjects as MeDTO['profile']['preferredSubjects'],theme:p.theme as MeDTO['profile']['theme'],reducedMotion:p.reducedMotion,onboarded:p.onboarded},aiMode:process.env.AI_MODE==='live'?'live':'mock'};
}
