import {spawnSync,spawn} from 'node:child_process';
const setup=spawnSync(process.execPath,['scripts/setup.mjs'],{stdio:'inherit'});
if(setup.status!==0)process.exit(setup.status??1);
const child=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1'],{stdio:'inherit'});
child.on('exit',code=>process.exit(code??0));
