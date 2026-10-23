import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
if(process.env.NODE_ENV==='production')throw new Error('Local setup is not a production deployment tool.');
function run(command,args){const r=spawnSync(command,args,{stdio:'inherit',shell:false});if(r.status!==0)process.exit(r.status??1);}
mkdirSync('.local',{recursive:true});
if(!existsSync('.env')){
  const template=readFileSync('.env.example','utf8').replace('replace-with-at-least-32-random-bytes',randomBytes(40).toString('hex')).replace('ENABLE_SIGNUP=false','ENABLE_SIGNUP=true').replace('INVITE_CODE=','INVITE_CODE=local-study-invite').replace('ALLOW_MOCK_IN_PRODUCTION=false','ALLOW_MOCK_IN_PRODUCTION=true');
  writeFileSync('.env',template,{flag:'wx'});
}
run('docker',['compose','up','-d','--wait','db']);
run(process.execPath,['node_modules/prisma/build/index.js','generate']);
run(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy']);
console.log('Local database ready. Start: npm run dev. Closed-test invite: local-study-invite (only for generated local .env).');
