import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const {directory}=JSON.parse(readFileSync('.local/latest-build.json','utf8'));
const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname',process.env.APP_HOST??'127.0.0.1',...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,NEXT_DIST_DIR:directory}});
child.on('exit',code=>process.exit(code??0));
