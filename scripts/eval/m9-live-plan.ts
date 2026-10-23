import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {buildM9LivePlan,checkM9LivePlan,M9_RULE_FILES} from '../../src/evaluation/m9-live-plan';

// No dotenv, provider import, live gateway, authorization writer, or network client.
const args=process.argv.slice(2);
async function main(){
  if(!(args.length===1&&args[0]==='prepare')&&!(args.length===2&&args[0]==='check'))throw new Error('ONLY_PREPARE_OR_CHECK_PLAN_NO_EXECUTION');
  const dataset=JSON.parse(await readFile('tests/evaluation/m7/math-candidates.inputs.json','utf8'));
  const sources=Object.fromEntries(await Promise.all(M9_RULE_FILES.map(async file=>[file,createHash('sha256').update(await readFile(file)).digest('hex')])));
  // This timestamp records the public official-document check in this M9 session,
  // not the time a future operator executes this script. Recheck after seven days.
  const envelope=args[0]==='prepare'?buildM9LivePlan(dataset,sources,'2026-10-23T13:34:20.000Z'):JSON.parse(await readFile(path.resolve(args[1]),'utf8'));
  const readiness=checkM9LivePlan(envelope,dataset,sources);
  const dir=path.resolve('.local/m9-live-plan',args[0]+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID());
  await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'plan.json'),JSON.stringify(envelope,null,2)+'\n',{flag:'wx'});
  await writeFile(path.join(dir,'readiness.json'),JSON.stringify(readiness,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({directory:dir,...readiness},null,2));
  if(args[0]==='check')process.exitCode=2;
}
main().catch(error=>{console.error(JSON.stringify({status:'BLOCKED',reason:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'INVALID_PLAN_OR_INPUT',networkRequests:0,newActualCostCny:0}));process.exitCode=2;});
