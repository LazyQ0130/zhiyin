// Compatibility entry point: env-only smoke now requires the same explicit one-use permit.
import {spawnSync} from 'node:child_process';
const result=spawnSync(process.execPath,['--import','tsx','scripts/eval/controlled.ts','--execute',...process.argv.slice(2)],{stdio:'inherit'});
process.exit(result.status??1);
