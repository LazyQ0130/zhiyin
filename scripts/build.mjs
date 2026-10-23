import {spawnSync} from 'node:child_process';
import {writeFileSync,mkdirSync} from 'node:fs';
const directory='.local/build-'+new Date().toISOString().replace(/[:.]/g,'-');
mkdirSync('.local',{recursive:true});
const generated=spawnSync(process.execPath,['node_modules/prisma/build/index.js','generate'],{stdio:'inherit'});
if(generated.status!==0)process.exit(generated.status??1);
const result=spawnSync(process.execPath,['node_modules/next/dist/bin/next','build'],{stdio:'inherit',env:{...process.env,NEXT_DIST_DIR:directory}});
if(result.status===0)writeFileSync('.local/latest-build.json',JSON.stringify({directory}));
process.exit(result.status??1);
