import {describe,expect,it,vi} from 'vitest';
import {AliyunGateway} from '../../src/server/ai/providers/aliyun';
import type {DiagnosisContext} from '../../src/server/ai/gateway';

const context:DiagnosisContext={questionId:'unit-q',questionText:'解 x²-5x+6=0。',subject:'MATH',gradeBand:'HIGH_SCHOOL',steps:[{id:'unit-s',text:'Δ=25+24=49'}],messages:[],findings:[],turnCount:0,hintLevel:0};
const output={schemaVersion:'1.0',action:'ASK_ONE_QUESTION',studentFacingText:'请说明你这一步的思路。',followUpQuestion:'请说明你这一步的思路。',referencedStepIds:['unit-s'],hintLevel:0,safetyFlags:[],findings:[{findingKey:'unit-cause',category:'KNOWLEDGE',statement:'学生记错公式。',status:'SUPPORTED',verificationNeeded:false,supportingEvidence:[{kind:'STUDENT_STEP',sourceId:'unit-s'}],contradictingEvidence:[]}]};
const fakeKey='UNIT_EVALUATION_NO_CREDENTIAL';
describe('opt-in multi-evaluation raw capture with synthetic transport',()=>{
  it('retains the exact raw text before server safeguards and binds maximum turns in the actual request',async()=>{
    const text=JSON.stringify(output),capture=vi.fn();let body:Record<string,unknown>|undefined;
    const fetchImpl=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{body=JSON.parse(String(init?.body));return Response.json({choices:[{finish_reason:'stop',message:{content:text}}],usage:{prompt_tokens:12,completion_tokens:22}});});
    const gateway=new AliyunGateway({apiKey:fakeKey,maxRetries:0,maximumDiagnosisTurns:3,onRawDiagnosisOutput:capture,fetchImpl});
    const guarded=await gateway.createDiagnosisTurn(context);
    expect(capture).toHaveBeenCalledExactlyOnceWith(text);
    expect(guarded.findings[0]).toMatchObject({status:'HYPOTHESIS',verificationNeeded:true,trust:{kind:'HYPOTHESIS'}});
    expect(guarded.findings[0].statement).not.toBe(output.findings[0].statement);
    const messages=body?.messages as Array<{content:string}>;
    expect(JSON.parse(messages[1].content).untrustedStudentMaterial.maximumTurns).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([['stop','{invalid JSON'],['length','{"partial":']] as const)('captures %s output even when validation fails',async(finish,raw)=>{
    const capture=vi.fn();const gateway=new AliyunGateway({apiKey:fakeKey,maxRetries:0,onRawDiagnosisOutput:capture,fetchImpl:async()=>Response.json({choices:[{finish_reason:finish,message:{content:raw}}],usage:{prompt_tokens:8,completion_tokens:4}})});
    await expect(gateway.createDiagnosisTurn(context)).rejects.toMatchObject({code:'AI_INVALID_OUTPUT'});
    expect(capture).toHaveBeenCalledExactlyOnceWith(raw);
    expect(gateway.lastInvocation).toMatchObject({inputTokens:8,outputTokens:4,status:'ERROR',attempts:1});
  });
  it('keeps default application request limits unchanged',async()=>{
    let maximum:number|undefined;
    const gateway=new AliyunGateway({apiKey:fakeKey,maxRetries:0,fetchImpl:async(_url,init)=>{const b=JSON.parse(String(init?.body));maximum=JSON.parse(b.messages[1].content).untrustedStudentMaterial.maximumTurns;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]});}});
    await gateway.createDiagnosisTurn(context);expect(maximum).toBe(6);
    expect(()=>new AliyunGateway({apiKey:fakeKey,maximumDiagnosisTurns:7})).toThrow();
  });
});
