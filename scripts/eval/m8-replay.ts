import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {evaluationDatasetSchema,evaluationRunSchema,hashValue} from '../../src/evaluation/schemas';
import {replayM7Protocol} from '../../src/evaluation/m8-replay';

// Fixed pre-M8 response: local only, no provider import or authorization reuse.
const historicalPath=path.resolve('.local/evaluations/2026-10-23T12-24-29-174Z-ddfe06f5-a65d-41ce-ad2b-152a645812d5/run.json');
const expectedSha256='d6c8b43d41fb400fedb812e026be3fdeb82a0a5ea15b72d28ddab8a5877fac78';
if(process.argv.length!==2)throw new Error('M8_REPLAY_ACCEPTS_NO_EXECUTE_OR_PROVIDER_ARGUMENTS');
if(!existsSync(historicalPath)){
  console.log(JSON.stringify({status:'NOT_RUN',reason:'HISTORICAL_PRIVATE_EVIDENCE_MISSING',networkRequests:0,newCostCny:0}));
  process.exitCode=2;
}else{
  const bytes=readFileSync(historicalPath);
  if(createHash('sha256').update(bytes).digest('hex')!==expectedSha256)throw new Error('HISTORICAL_EVIDENCE_HASH_MISMATCH');
  const run=evaluationRunSchema.parse(JSON.parse(bytes.toString('utf8')));
  const dataset=evaluationDatasetSchema.parse(JSON.parse(readFileSync('tests/evaluation/m7-protocol.inputs.json','utf8')));
  const entry=dataset.cases[0];const record=run.records[0];
  if(run.mode!=='LIVE_API'||run.provider==='mock'||run.datasetHash!==hashValue(dataset)||record?.inputHash!==hashValue(entry.context)||record.caseId!==entry.id||record.status!=='SUCCESS'||run.records.length!==1)throw new Error('HISTORICAL_EVIDENCE_BINDING_MISMATCH');
  const replay=replayM7Protocol(entry.context,record.output);
  const result={status:replay.allGuardsPassed?'PASSED':'FAILED',historicalEvidenceSha256:expectedSha256,historicalRunId:run.runId,historicalInvocation:record.invocation,...replay};
  const outputDirectory=path.resolve('.local/m8-replays',new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID());
  mkdirSync(outputDirectory,{recursive:true});
  writeFileSync(path.join(outputDirectory,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({...result,outputDirectory},null,2));
  if(!replay.allGuardsPassed)process.exitCode=1;
}
