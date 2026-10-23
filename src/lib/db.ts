import 'server-only';
import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
const globalDb=globalThis as unknown as {zhiyinDb?:PrismaClient};
export const db=globalDb.zhiyinDb ?? new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL,max:10}),log:[]});
if(process.env.NODE_ENV!=='production') globalDb.zhiyinDb=db;
