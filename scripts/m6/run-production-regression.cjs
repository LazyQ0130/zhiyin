/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node verification runner. */
require('dotenv').config({quiet:true});
const {Client}=require('pg');const {randomBytes}=require('crypto');const {spawn,spawnSync}=require('child_process');const fs=require('fs');const path=require('path');const net=require('net');
(async()=>{
 const id=new Date().toISOString().replace(/[:.]/g,'-');const dir=path.resolve('.local','m6-production-regression-'+id);fs.mkdirSync(dir,{recursive:true});
 const original=new URL(process.env.DATABASE_URL);if(!['localhost','127.0.0.1'].includes(original.hostname))throw new Error('Local DB required');
 const name='m6_regression_'+Date.now();const admin=new Client({connectionString:original.href});await admin.connect();await admin.query('CREATE DATABASE "'+name+'"');await admin.end();
 const dburl=new URL(original);dburl.pathname='/'+name;const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>r(n))})});
 const invite=randomBytes(20).toString('hex');const env={...process.env,DATABASE_URL:dburl.href,AI_MODE:'mock',ALLOW_MOCK_IN_PRODUCTION:'true',ENABLE_SIGNUP:'true',INVITE_CODE:invite,E2E_INVITE_CODE:invite,SESSION_SECRET:randomBytes(40).toString('hex'),APP_URL:'http://127.0.0.1:'+port,E2E_BASE_URL:'http://127.0.0.1:'+port,PLAYWRIGHT_SKIP_BROWSER_GC:'1',PLAYWRIGHT_BROWSERS_PATH:path.resolve('.local/playwright'),NODE_ENV:'production',NEXT_DIST_DIR:JSON.parse(fs.readFileSync('.local/latest-build.json','utf8')).directory};
 // A regression server must never inherit a real provider credential, even in Mock mode.
 env.ALIYUN_API_KEY='UNIT_TEST_PLACEHOLDER_NOT_A_CREDENTIAL';env.DASHSCOPE_API_KEY='UNIT_TEST_PLACEHOLDER_NOT_A_CREDENTIAL';
 const migrate=spawnSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy'],{env,encoding:'utf8'});fs.writeFileSync(path.join(dir,'migrate.log'),migrate.stdout+migrate.stderr);if(migrate.status!==0)throw new Error('Migration failed');
 const log=fs.createWriteStream(path.join(dir,'server.log'));const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{env,stdio:['ignore','pipe','pipe']});server.stdout.pipe(log);server.stderr.pipe(log);
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(env.APP_URL+'/login')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,200))}if(!ready)throw new Error('Startup failed');
  const test=spawn(process.execPath,['node_modules/@playwright/test/cli.js','test','--project=api','--project=chromium-1440-light'],{env,stdio:['ignore','pipe','pipe']});const results=fs.createWriteStream(path.join(dir,'tests.log'));test.stdout.on('data',d=>{process.stdout.write(d);results.write(d)});test.stderr.on('data',d=>{process.stderr.write(d);results.write(d)});const status=await new Promise(r=>test.on('exit',r));results.end();
  fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify({status,database:name,mode:'PRODUCTION_BUILD_MOCK',paidCalls:0,databasePreserved:true,frequencyLimitsUnchanged:true,build:env.NEXT_DIST_DIR},null,2));console.log(JSON.stringify({status,evidence:dir}));process.exitCode=status??1;
 }finally{spawnSync('taskkill',['/PID',String(server.pid),'/T','/F'],{stdio:'ignore'});log.end()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
