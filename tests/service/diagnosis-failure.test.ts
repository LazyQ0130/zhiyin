import {randomUUID} from "node:crypto";
import {mkdir,writeFile} from "node:fs/promises";
import {hash} from "@node-rs/argon2";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {db} from "@/lib/db";
import {runTurn} from "@/server/services/diagnosis";
import {MockGateway} from "@/server/ai/providers/mock";
import {AliyunGateway} from "@/server/ai/providers/aliyun";
import type {DiagnosisContext} from "@/server/ai/gateway";
import type {DiagnosisTurn} from "@/server/ai/schemas/diagnosis";

const mockFactory=()=>new MockGateway();
const key=()=>randomUUID().replaceAll("-", "");
const reply="我明白了，-4ac=-24，所以是1；上一行确实是我写错了。";
const createdUsers:string[]=[];
const evidence:Array<Record<string,unknown>>=[];

beforeAll(async()=>{
  if(!process.env.DATABASE_URL)throw new Error("Service integration tests require the configured PostgreSQL DATABASE_URL.");
  await db.$queryRaw`SELECT 1`;
});
afterAll(async()=>{
  const directory=`.local/service-evidence/${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}`;
  await mkdir(directory,{recursive:true});
  await writeFile(`${directory}/results.json`,JSON.stringify({executedAt:new Date().toISOString(),database:"PostgreSQL",serviceTestDataPolicy:"Created isolated random users only; no records deleted.",createdUserIds:createdUsers,expectedCases:5,completedCases:evidence.length,evidence},null,2)+"\n",{flag:'wx'});
  await db.$disconnect();
});

async function fixture(){
  const user=await db.user.create({data:{email:`service-test-${randomUUID()}@example.test`,passwordHash:await hash(randomUUID()),profile:{create:{displayName:"服务故障测试",ageBand:"ADULT",consentStatus:"ADULT_ACCEPTED",onboarded:true}}}});
  createdUsers.push(user.id);
  const questionText="解一元二次方程 x² - 5x + 6 = 0。";
  const problem=await db.problem.create({data:{userId:user.id,subject:"MATH",gradeBand:"HIGH_SCHOOL",questionText,imageIds:[]}});
  const revision=await db.problemRevision.create({data:{problemId:problem.id,questionText,imageIds:[],revisionNumber:1,confirmedAt:new Date()}});
  await db.problem.update({where:{id:problem.id,userId:user.id},data:{currentRevisionId:revision.id}});
  const attempt=await db.attempt.create({data:{userId:user.id,problemId:problem.id,problemRevisionId:revision.id,rawProcess:"a=1,b=-5,c=6\nΔ=25+24=49\nx=(5±7)/2",stuckReasons:["MY_ANSWER_LOOKS_WRONG"],attemptStatus:"ATTEMPTED",steps:{create:[{order:1,text:"a=1,b=-5,c=6"},{order:2,text:"Δ=25+24=49"},{order:3,text:"x=(5±7)/2"}]}}});
  const session=await db.diagnosisSession.create({data:{userId:user.id,attemptId:attempt.id,modelRoute:"service-test-mock",isDemo:true}});
  const initial=await runTurn(user.id,session.id,key(),{action:"INITIAL",content:""},mockFactory);
  expect(initial.status).toBe("QUESTIONING");
  return {userId:user.id,sessionId:session.id};
}
async function persisted(f:{userId:string;sessionId:string}){
  return db.diagnosisSession.findFirstOrThrow({where:{id:f.sessionId,userId:f.userId},include:{messages:{orderBy:{sequence:"asc"}},findings:{include:{evidence:true}},invocations:true}});
}

describe("PostgreSQL diagnosis failure recovery",()=>{
  it.each(["AI_TIMEOUT","AI_INVALID_OUTPUT"] as const)("preserves student input and completes the same operation after %s",async(code)=>{
    const f=await fixture();
    const operation=key();
    const fetchImpl=code==="AI_TIMEOUT"
      ? vi.fn<typeof fetch>().mockImplementation(()=>new Promise<Response>(()=>{}))
      : vi.fn<typeof fetch>().mockImplementation(async()=>Response.json({choices:[{message:{content:"{invalid JSON"}}],usage:{prompt_tokens:11,completion_tokens:2}}));
    const failureFactory=()=>new AliyunGateway({apiKey:"SERVICE_TEST_PLACEHOLDER_NOT_A_CREDENTIAL",fetchImpl,timeoutMs:code==="AI_TIMEOUT"?5:1000,sleep:async()=>{}});
    await expect(runTurn(f.userId,f.sessionId,operation,{action:"REPLY",content:reply},failureFactory)).rejects.toMatchObject({code,status:503});
    const failed=await persisted(f);
    expect(failed.status).toBe("FAILED_RETRYABLE");expect(failed.turnCount).toBe(1);expect(failed.lockToken).toBeNull();
    expect(failed.messages.filter(m=>m.operationKey===operation&&m.role==="USER")).toHaveLength(1);
    expect(failed.messages.find(m=>m.operationKey===operation)?.content).toBe(reply);
    expect(failed.messages.filter(m=>m.operationKey===operation&&m.role==="ASSISTANT")).toHaveLength(0);
    expect(failed.invocations.filter(i=>i.status==="ERROR")).toHaveLength(1);
    expect(failed.invocations.find(i=>i.status==="ERROR")?.errorClass).toBe(code);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    if(code==="AI_INVALID_OUTPUT")expect(failed.invocations.find(i=>i.status==="ERROR")).toMatchObject({inputTokens:22,outputTokens:4});
    const recovered=await runTurn(f.userId,f.sessionId,key(),{action:"RETRY",content:""},mockFactory);
    expect(recovered.status).toBe("REPORT_READY");
    const stable=await persisted(f);
    expect(stable.turnCount).toBe(2);
    expect(stable.messages.filter(m=>m.operationKey===operation&&m.role==="USER")).toHaveLength(1);
    expect(stable.messages.filter(m=>m.operationKey===operation&&m.role==="ASSISTANT")).toHaveLength(1);
    expect(stable.invocations.filter(i=>i.status==="SUCCESS")).toHaveLength(2);
    expect(stable.invocations).toHaveLength(3);
    const mutation=await db.mutationKey.findUniqueOrThrow({where:{userId_scope_key:{userId:f.userId,scope:`turn:${f.sessionId}`,key:operation}}});
    expect(mutation.status).toBe("COMPLETED");
    const shouldNotCall=vi.fn(()=>{throw new Error("cached replay must not invoke a model");});
    await runTurn(f.userId,f.sessionId,operation,{action:"REPLY",content:reply},shouldNotCall);
    expect(shouldNotCall).not.toHaveBeenCalled();
    const replayed=await persisted(f);
    expect(replayed.messages).toHaveLength(stable.messages.length);expect(replayed.invocations).toHaveLength(3);
    evidence.push({case:code,userId:f.userId,sessionId:f.sessionId,states:[failed.status,stable.status],studentMessagesForOperation:1,successInvocations:2,errorInvocations:1,replayCreatedRows:0});
  });

  it("retains a failed FINISH intent and retries it without invoking a model",async()=>{
    const f=await fixture();
    const original=await persisted(f);
    const finding=original.findings[0];
    // Corrupt only this newly created fixture to force a real service read/validation failure after its lease commits.
    await db.diagnosisFinding.update({where:{id:finding.id,sessionId:f.sessionId},data:{statement:""}});
    const operation=key();
    const shouldNotCall=vi.fn(()=>{throw new Error("FINISH must not invoke a model");});
    await expect(runTurn(f.userId,f.sessionId,operation,{action:"FINISH",content:""},shouldNotCall)).rejects.toMatchObject({code:"AI_INVALID_OUTPUT"});
    const failed=await persisted(f);
    expect(failed.status).toBe("FAILED_RETRYABLE");
    expect(failed.messages.filter(m=>m.operationKey===operation&&m.kind==="FINISH"&&m.role==="USER")).toHaveLength(1);
    await db.diagnosisFinding.update({where:{id:finding.id,sessionId:f.sessionId},data:{statement:finding.statement}});
    const recovered=await runTurn(f.userId,f.sessionId,key(),{action:"RETRY",content:""},shouldNotCall);
    expect(recovered.status).toBe("INCONCLUSIVE");expect(shouldNotCall).not.toHaveBeenCalled();
    const stable=await persisted(f);
    expect(stable.messages.filter(m=>m.operationKey===operation&&m.role==="USER")).toHaveLength(1);
    expect(stable.messages.filter(m=>m.operationKey===operation&&m.role==="ASSISTANT")).toHaveLength(1);
    expect(stable.invocations).toHaveLength(1);
    expect(stable.findings.every(item=>item.status==="UNRESOLVED"||item.status==="REFUTED")).toBe(true);
    expect(stable.finishedAt).not.toBeNull();
    evidence.push({case:"FINISH_RECOVERY",userId:f.userId,sessionId:f.sessionId,states:[failed.status,stable.status],modelCallsDuringFinish:0,evidenceRows:stable.findings.reduce((n,item)=>n+item.evidence.length,0),fault:"Invalid statement in isolated fixture causes service validation failure after lease commit; no database outage was simulated."});
  });

  it("rejects an active lease and safely resumes once its lease has expired",async()=>{
    const f=await fixture();
    const operation=key();
    await db.diagnosisSession.update({where:{id:f.sessionId,userId:f.userId},data:{status:"EVALUATING",lockToken:"fixture-held-lock",lockUntil:new Date(Date.now()+60000)}});
    const shouldNotCall=vi.fn(()=>new MockGateway());
    await expect(runTurn(f.userId,f.sessionId,operation,{action:"REPLY",content:reply},shouldNotCall)).rejects.toMatchObject({code:"SESSION_BUSY",status:409});
    expect(shouldNotCall).not.toHaveBeenCalled();
    expect((await persisted(f)).messages.filter(m=>m.operationKey===operation)).toHaveLength(0);
    await db.diagnosisSession.update({where:{id:f.sessionId,userId:f.userId},data:{lockUntil:new Date(Date.now()-1000)}});
    const recovered=await runTurn(f.userId,f.sessionId,operation,{action:"REPLY",content:reply},mockFactory);
    expect(recovered.status).toBe("REPORT_READY");
    const stable=await persisted(f);expect(stable.lockToken).toBeNull();expect(stable.lockUntil).toBeNull();expect(stable.invocations).toHaveLength(2);
    evidence.push({case:"LEASE_RECOVERY",userId:f.userId,sessionId:f.sessionId,activeLease:"SESSION_BUSY",expiredLease:stable.status});
  });

  it("preserves evidence but downgrades omitted prior findings in the final report",async()=>{
    const f=await fixture();
    const original=await persisted(f);
    await db.diagnosisFinding.update({where:{id:original.findings[0].id,sessionId:f.sessionId},data:{status:"SUPPORTED",primary:true}});
    class OmittingGateway extends MockGateway {
      async createDiagnosisTurn(input:DiagnosisContext):Promise<DiagnosisTurn>{
        const result=await super.createDiagnosisTurn(input);
        return {...result,findings:[],studentFacingText:"已确认：保存了本次步骤与对话。待确认：当前没有足够证据支持具体原因。"};
      }
    }
    await runTurn(f.userId,f.sessionId,key(),{action:"REPLY",content:reply},()=>new OmittingGateway());
    const stable=await persisted(f);
    expect(stable.status).toBe("REPORT_READY");expect(stable.findings).toHaveLength(original.findings.length);
    expect(stable.findings.every(item=>item.status==="UNRESOLVED"&&!item.primary)).toBe(true);
    expect(stable.findings.reduce((n,item)=>n+item.evidence.length,0)).toBe(original.findings.reduce((n,item)=>n+item.evidence.length,0));
    evidence.push({case:"OMITTED_FINDING",userId:f.userId,sessionId:f.sessionId,findingsRetained:stable.findings.length,primaryFindings:0});
  });
});
