import { describe, expect, it, vi, afterEach } from "vitest";
import { AliyunGateway } from "../../src/server/ai/providers/aliyun";
import { createGateway, type DiagnosisContext } from "../../src/server/ai/gateway";
import { MockGateway } from "../../src/server/ai/providers/mock";

const input: DiagnosisContext={questionId:"q1",questionText:"解 x²-5x+6=0。",subject:"MATH",gradeBand:"HIGH_SCHOOL",steps:[{id:"s1",text:"Δ=25+24=49"}],messages:[],findings:[],turnCount:0,hintLevel:0};
const fakeKey="UNIT_TEST_PLACEHOLDER_NOT_A_CREDENTIAL";
const noWait=async ()=>{};
async function validEnvelope() {
  return {choices:[{message:{content:JSON.stringify(await new MockGateway().createDiagnosisTurn(input))},finish_reason:"stop"}],usage:{prompt_tokens:31,completion_tokens:47}};
}
afterEach(()=>vi.unstubAllEnvs());
describe("Aliyun Gateway contract without paid calls",()=>{
  it("requires a server key and only accepts official HTTPS endpoints",()=>{
    expect(()=>new AliyunGateway({apiKey:""})).toThrow("真实模型尚未配置");
    expect(()=>new AliyunGateway({apiKey:fakeKey,baseUrl:"https://untrusted.example/v1"})).toThrow();
  });
  it("sends validated JSON requests, captures actual usage, and minimizes recent history",async()=>{
    const response=await validEnvelope();
    const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
    const gateway=new AliyunGateway({apiKey:fakeKey,fetchImpl});
    const result=await gateway.createDiagnosisTurn(input);
    expect(result.action).toBe("ASK_ONE_QUESTION");
    const init=fetchImpl.mock.calls[0][1];
    const body=JSON.parse(String(init?.body));
    expect(body.model).toBe("qwen3.8-flash");expect(body.response_format.type).toBe("json_object");expect(body.enable_thinking).toBe(false);
    expect(gateway.lastInvocation).toMatchObject({inputTokens:31,outputTokens:47,attempts:1,status:"SUCCESS",costEstimate:null});
    expect(JSON.stringify(gateway.lastInvocation)).not.toContain(fakeKey);
  });
  it("retries invalid JSON once and totals usage from both responses",async()=>{
    const response=await validEnvelope();
    const invalid={choices:[{message:{content:"not json"}}],usage:{prompt_tokens:3,completion_tokens:4}};
    const fetchImpl=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(invalid)).mockResolvedValueOnce(Response.json(response));
    const gateway=new AliyunGateway({apiKey:fakeKey,fetchImpl,sleep:noWait});
    await gateway.createDiagnosisTurn(input);
    expect(fetchImpl).toHaveBeenCalledTimes(2);expect(gateway.lastInvocation).toMatchObject({inputTokens:34,outputTokens:51,attempts:2});
  });
  it("rejects repeated malformed output without leaking provider text",async()=>{
    const fetchImpl=vi.fn<typeof fetch>().mockImplementation(async()=>Response.json({choices:[{message:{content:`secret ${fakeKey}`}}]}));
    const gateway=new AliyunGateway({apiKey:fakeKey,fetchImpl,sleep:noWait});
    await expect(gateway.createDiagnosisTurn(input)).rejects.toMatchObject({code:"AI_INVALID_OUTPUT"});
    expect(fetchImpl).toHaveBeenCalledTimes(2);expect(JSON.stringify(gateway.lastInvocation)).not.toContain(fakeKey);
  });
  it("stops a stalled model with a bounded timeout and only one retry",async()=>{
    const fetchImpl=vi.fn<typeof fetch>().mockImplementation(()=>new Promise<Response>(()=>{}));
    const gateway=new AliyunGateway({apiKey:fakeKey,fetchImpl,timeoutMs:5,sleep:noWait});
    await expect(gateway.createDiagnosisTurn(input)).rejects.toMatchObject({code:"AI_TIMEOUT"});
    expect(fetchImpl).toHaveBeenCalledTimes(2);expect(gateway.lastInvocation?.status).toBe("ERROR");
  });
  it("retries 429 but does not retry 401 or expose response bodies",async()=>{
    const limited=vi.fn<typeof fetch>().mockImplementation(async()=>new Response(fakeKey,{status:429}));
    await expect(new AliyunGateway({apiKey:fakeKey,fetchImpl:limited,sleep:noWait}).createDiagnosisTurn(input)).rejects.toMatchObject({code:"AI_RATE_LIMITED"});
    expect(limited).toHaveBeenCalledTimes(2);
    const denied=vi.fn<typeof fetch>().mockImplementation(async()=>new Response(fakeKey,{status:401}));
    await expect(new AliyunGateway({apiKey:fakeKey,fetchImpl:denied,sleep:noWait}).createDiagnosisTurn(input)).rejects.not.toThrow(fakeKey);
    expect(denied).toHaveBeenCalledTimes(1);
  });
  it("rejects foreign evidence and never falls back silently to Mock",async()=>{
    const response=await validEnvelope();
    const turn=JSON.parse(response.choices[0].message.content);turn.referencedStepIds=["another-owner-step"];
    response.choices[0].message.content=JSON.stringify(turn);
    const fetchImpl=vi.fn<typeof fetch>().mockImplementation(async()=>Response.json(response));
    await expect(new AliyunGateway({apiKey:fakeKey,fetchImpl,sleep:noWait}).createDiagnosisTurn(input)).rejects.toMatchObject({code:"AI_INVALID_OUTPUT"});
    vi.stubEnv("AI_MODE","live");vi.stubEnv("ALIYUN_API_KEY","");vi.stubEnv("DASHSCOPE_API_KEY","");
    expect(()=>createGateway()).toThrow();
  });
  it("rejects production mock unless explicitly enabled",()=>{
    vi.stubEnv("NODE_ENV","production");vi.stubEnv("AI_MODE","mock");vi.stubEnv("ALLOW_MOCK_IN_PRODUCTION","");
    expect(()=>createGateway()).toThrow();
    vi.stubEnv("ALLOW_MOCK_IN_PRODUCTION","true");expect(createGateway().mode).toBe("mock");
  });
});
