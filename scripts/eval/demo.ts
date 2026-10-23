import { readFile, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { evaluationDatasetSchema, evaluationRunSchema, hashValue, type EvaluationRun } from "../../src/evaluation/schemas";
import { scoreEvaluation } from "../../src/evaluation/score";

if(!process.argv.includes("--worker")) {
  const child=spawnSync(process.execPath,["--conditions=react-server","--import","tsx",fileURLToPath(import.meta.url),"--worker"],{stdio:"inherit",cwd:process.cwd()});process.exit(child.status??1);
}
const {MockGateway}=await import("../../src/server/ai/providers/mock");
const dataset=evaluationDatasetSchema.parse(JSON.parse(await readFile("tests/evaluation/engineering.inputs.json","utf8")));
const annotations=JSON.parse(await readFile("tests/evaluation/engineering.annotations.json","utf8")) as unknown;
const run:EvaluationRun={schemaVersion:"1.0",runId:`mock-${randomUUID()}`,createdAt:new Date().toISOString(),datasetId:dataset.datasetId,datasetVersion:dataset.version,datasetHash:hashValue(dataset),caseIds:dataset.cases.map(c=>c.id),mode:"SIMULATED",provider:"mock",model:"deterministic-demo-v1",promptVersion:"diagnosis-v1.0.0",records:[]};
for(const sample of dataset.cases) {
  const gateway=new MockGateway(),start=Date.now();
  try {
    const output=await gateway.createDiagnosisTurn(sample.context);
    run.records.push({caseId:sample.id,inputHash:hashValue(sample.context),status:"SUCCESS",output,invocation:{latencyMs:Date.now()-start,inputTokens:null,outputTokens:null,attempts:1,estimatedCostCny:0,costBasis:"确定性本地Mock：没有供应商调用；0费用仅指供应商API。"}});
  } catch {
    run.records.push({caseId:sample.id,inputHash:hashValue(sample.context),status:"ERROR",errorCode:"MOCK_ERROR",invocation:{latencyMs:Date.now()-start,inputTokens:null,outputTokens:null,attempts:1,estimatedCostCny:0,costBasis:"确定性本地Mock：没有供应商调用。"}});
  }
}
evaluationRunSchema.parse(run);
const report=scoreEvaluation(dataset,run,annotations),output=path.resolve(".local","m6-evaluation",run.runId);
await mkdir(output,{recursive:true});
await writeFile(path.join(output,"run.json"),JSON.stringify(run,null,2)+"\n",{flag:"wx"});
await writeFile(path.join(output,"score.json"),JSON.stringify(report,null,2)+"\n",{flag:"wx"});
console.log(JSON.stringify({status:report.reliability.failed?"HAS_FAILURES":"SIMULATED_ONLY",output,reliability:report.reliability,engineeringMetrics:report.engineeringMetrics,teacherComparison:report.teacherComparison,cost:report.cost},null,2));
if(report.reliability.failed)process.exitCode=1;
