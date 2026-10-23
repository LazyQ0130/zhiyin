import "dotenv/config";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--smoke-worker")) {
  const child=spawnSync(process.execPath,["--conditions=react-server","--import","tsx",fileURLToPath(import.meta.url),"--smoke-worker"],{stdio:"inherit",cwd:process.cwd()});
  process.exit(child.status??1);
}
if(process.env.AI_MODE!=="live"||!(process.env.ALIYUN_API_KEY??process.env.DASHSCOPE_API_KEY)?.trim()) {
  console.error("未调用模型：此烟雾测试需要显式 AI_MODE=live 和服务器 ALIYUN_API_KEY。可能产生真实供应商费用。");
  process.exit(2);
}
const {createGateway,GatewayError}=await import("../../src/server/ai/gateway");
try {
  const gateway=createGateway();
  const turn=await gateway.createDiagnosisTurn({questionId:"smoke-q",questionText:"解 x²-5x+6=0。",subject:"MATH",gradeBand:"HIGH_SCHOOL",steps:[{id:"smoke-step-1",text:"a=1,b=-5,c=6"},{id:"smoke-step-2",text:"Δ=25+24=49"}],messages:[],findings:[],turnCount:0,hintLevel:0});
  console.log(JSON.stringify({status:"VALIDATED_RESPONSE",action:turn.action,referencedStepIds:turn.referencedStepIds,invocation:gateway.lastInvocation,limitation:"一次协议烟雾测试不代表教学诊断准确率。"},null,2));
} catch(error) {
  console.error(JSON.stringify({status:"FAILED",code:error instanceof GatewayError?error.code:"UNKNOWN_ERROR"}));
  process.exitCode=1;
}
