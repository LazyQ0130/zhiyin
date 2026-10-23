import {spawnSync} from 'node:child_process';
// Fixed one-case input and request limit. Never read teacher labels or run a batch.
const args=process.argv.slice(2);
const allowed=new Set(['--execute','--permit']);
for(let i=0;i<args.length;i++){
  if(!allowed.has(args[i])||(args[i]==='--permit'&&(!args[i+1]||args[i+1].startsWith('--')))){
    console.error('Only --execute and --permit <local authorization> are supported.');process.exit(2);
  }
  if(args[i]==='--permit')i++;
}
const result=spawnSync(process.execPath,['--import','tsx','scripts/eval/controlled.ts','--dataset','tests/evaluation/m7-protocol.inputs.json','--case','m7-protocol-sign','--single-protocol',...args],{stdio:'inherit'});
process.exit(result.status??1);
