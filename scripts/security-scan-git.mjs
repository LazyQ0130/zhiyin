import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const secretNames = new Set(['SESSION_SECRET','ALIYUN_API_KEY','DASHSCOPE_API_KEY','DEEPSEEK_API_KEY','S3_SECRET_ACCESS_KEY']);
const secrets = new Set();
for (const name of secretNames) if (process.env[name]?.length >= 12) secrets.add(process.env[name]);
for (const file of ['.env','.env.local','.env.production','.env.production.local']) {
  try {
    for (const line of readFileSync(file,'utf8').split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)\s*=\s*["']?(.+?)["']?\s*$/);
      if (match && secretNames.has(match[1]) && match[2].length >= 12 && !/example|replace|changeme/i.test(match[2])) secrets.add(match[2]);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const files = execFileSync('git',['diff','--cached','--name-only','-z','--diff-filter=ACMR'],{encoding:'utf8'}).split('\0').filter(Boolean);
const findings=[];
for (const file of files) {
  if (/(?:^|\/)(?:\.env(?:\..+)?|node_modules|\.local|\.next|generated|QA-evidence)(?:\/|$)/.test(file) && file!=='.env.example'
      || /(?:\.dump|\.sql\.gz|storageState\.json|trace\.zip|latest-results\.json|tsbuildinfo)$/.test(file)) findings.push({file,reason:'RUNTIME_OR_SECRET_FILE'});
  const content = execFileSync('git',['show',`:${file}`],{maxBuffer:32*1024*1024}).toString('utf8');
  if ([...secrets].some(secret=>content.includes(secret)) || /\bsk-(?:ws-)?[A-Za-z0-9_.-]{24,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) findings.push({file,reason:'SECRET_PATTERN'});
}
console.log(JSON.stringify({stagedFiles:files.length,knownSecretChecks:secrets.size,findings,passed:files.length>0&&findings.length===0},null,2));
if (!files.length || findings.length) process.exitCode=1;
