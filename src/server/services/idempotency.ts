import 'server-only';
import {db} from '@/lib/db';
import type {Prisma} from '@/generated/prisma/client';
import {AppError,hashInput} from '@/server/security/http';
export async function atomicMutation(userId:string,scope:string,key:string,input:unknown,run:(tx:Prisma.TransactionClient)=>Promise<string>){
  return db.$transaction(async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId+scope+key}))`;
    const old=await tx.mutationKey.findUnique({where:{userId_scope_key:{userId,scope,key}}});
    const inputHash=hashInput(input);
    if(old){if(old.inputHash!==inputHash)throw new AppError('INVALID_INPUT','相同提交标识不能用于不同内容。',409);if(old.resourceId)return old.resourceId;throw new AppError('SESSION_BUSY','提交正在处理中。',409);}
    const resourceId=await run(tx);
    await tx.mutationKey.create({data:{userId,scope,key,inputHash,resourceId,status:'COMPLETED'}});
    return resourceId;
  },{timeout:15000});
}
