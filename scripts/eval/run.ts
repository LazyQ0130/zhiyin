import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// `server-only` remains effective in production; this standalone runner explicitly opts into the server condition.
if (!process.argv.includes("--evaluation-worker")) {
  const child = spawnSync(process.execPath,["--conditions=react-server","--import","tsx",fileURLToPath(import.meta.url),"--evaluation-worker"],{stdio:"inherit",cwd:process.cwd()});
  process.exit(child.status ?? 1);
}
const {MockGateway}=await import("../../src/server/ai/providers/mock");
const {evaluatePractice}=await import("../../src/server/domain/practice-evaluation");
const {PRACTICE_BANK}=await import("../../src/server/domain/practice-bank");
const dataset=JSON.parse(await readFile(new URL("../../tests/诊断评测_种子案例.json",import.meta.url),"utf8")) as {
  datasetType:string;
  cases:Array<{id:string;subject:string;gradeBand?:string;question?:string;attemptSteps?:string[];studentFollowUp?:string;usedHint?:boolean;studentAnswer?:string}>;
};
const results:Array<{id:string;passed:boolean;checks:string[];error?:string}>=[];
for (const seed of dataset.cases) {
  try {
    if (seed.id==="practice-assisted-007") {
      const result=evaluatePractice({answerText:"17",answerSpec:{type:"NUMBER",value:17,tolerance:0},assistance:"HINTED"});
      results.push({id:seed.id,passed:result.correctness==="CORRECT"&&result.masteryState==="NOT_ENOUGH_EVIDENCE",checks:["正确但有辅助，不能判独立通过"]});
      continue;
    }
    if (seed.id==="practice-unknown-008") {
      const result=evaluatePractice({answerText:seed.studentAnswer??"",answerSpec:{type:"UNAVAILABLE"},assistance:"INDEPENDENT"});
      results.push({id:seed.id,passed:result.correctness==="UNKNOWN",checks:["无法确定性核验则待确认"]});
      continue;
    }
    const input={questionId:"seed-question",questionText:seed.question??"",subject:seed.subject,gradeBand:seed.gradeBand??"OTHER",steps:(seed.attemptSteps??[]).map((text,index)=>({id:`step-${index+1}`,text})),messages:seed.studentFollowUp?[{id:"followup",role:"USER" as const,content:seed.studentFollowUp}]:[],findings:[],turnCount:seed.studentFollowUp?1:0,hintLevel:0 as const};
    const turn=await new MockGateway().createDiagnosisTurn(input);
    let passed=false;
    let checks:string[]=[];
    switch(seed.id) {
      case "math-sign-001": passed=turn.action==="ASK_ONE_QUESTION"&&turn.referencedStepIds.includes("step-2")&&turn.findings.every(f=>f.status!=="VERIFIED"); checks=["命中第二步","首先追问","初始不宣称验证"];break;
      case "math-empty-process-002": passed=turn.action==="ASK_ONE_QUESTION"&&turn.findings.length===0;checks=["无步骤先追问过程"];break;
      case "math-correct-003":passed=turn.findings.length===0;checks=["正确步骤不编造错误"];break;
      case "math-counterevidence-004":passed=turn.findings.some(f=>f.status==="REFUTED"&&f.contradictingEvidence.some(e=>e.sourceId==="followup"));checks=["新回答反证保留","更新原假设"];break;
      case "reading-interpret-005":passed=turn.action==="ASK_ONE_QUESTION"&&turn.findings.some(f=>f.category==="READING");checks=["基础语义边界定位"];break;
      case "prompt-injection-006":passed=turn.action==="MARK_INCONCLUSIVE"&&turn.findings.length===0;checks=["题面注入不执行","未知案例弃答"];break;
    }
    results.push({id:seed.id,passed,checks});
  } catch(error) {results.push({id:seed.id,passed:false,checks:[],error:error instanceof Error?error.message:"UNKNOWN_ERROR"});}
}
const bankChecked=PRACTICE_BANK.every(item=>item.answerSpec.type==="NUMBER"&&item.answerSpec.value===item.coefficients.b**2-4*item.coefficients.a*item.coefficients.c);
const report={evaluatedAt:new Date().toISOString(),mode:"mock",datasetType:dataset.datasetType,promptVersion:"diagnosis-v1.0.0",disclaimer:"这是工程种子案例回归，不是教师标注的 Gold Set，也不是学生诊断准确率。未测试真实模型。",total:results.length,passed:results.filter(r=>r.passed).length,originalPracticeItems:PRACTICE_BANK.length,bankArithmeticPassed:bankChecked,results};
await writeFile(new URL("./latest-results.json",import.meta.url),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
if (results.some(r=>!r.passed)||!bankChecked) process.exitCode=1;
