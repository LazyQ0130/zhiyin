import 'dotenv/config';
import {PrismaClient} from '../src/generated/prisma/client';
import {PrismaPg} from '@prisma/adapter-pg';
import {hash} from '@node-rs/argon2';
if(process.env.NODE_ENV==='production')throw new Error('禁止在生产环境创建测试用户。');
const email=process.env.SEED_DEMO_USER_EMAIL;
const password=process.env.SEED_DEMO_USER_PASSWORD;
if(!email||!password||password.length<12)throw new Error('请显式设置 SEED_DEMO_USER_EMAIL 与至少12位的 SEED_DEMO_USER_PASSWORD；不会创建默认后门账户。');
const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL})});
try{
  const user=await db.user.upsert({where:{email},update:{},create:{email,passwordHash:await hash(password),profile:{create:{displayName:'本地试测者',ageBand:'ADULT',consentStatus:'LOCAL_ENGINEERING_TEST_ONLY',onboarded:true}}}});
  console.log(JSON.stringify({createdOrExistingUserId:user.id,warning:'本地工程试测账号；没有自动填充学习成就。'}));
}finally{await db.$disconnect();}
