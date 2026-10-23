import {describe,expect,it} from 'vitest';
import {knownNoAssistance,mergeAssistanceReviews,parseAssistanceReview,recordedPracticeAssistance,reviewAssistance} from '../../src/server/domain/assistance-review';
import {escalateAssistance,evaluatePractice} from '../../src/server/domain/practice-evaluation';

describe('server content assistance review',()=>{
  it.each([
    ['先检查第二步的负号。',1],
    ['Check the sign in your second step.',1],
    ['判别式公式是 Δ = b² − 4ac，所以这两个项之间应加还是减？',2],
    ['Use \\( \\Delta = b^{2} - 4ac \\). Which sign belongs here?',2],
    ['At least includes equality. Does 12 qualify?',2],
    ['“至少”包含等于，恰好到边界也在范围内。',2],
    ['After did, use the base form.',2],
    ['正确答案是 17。',3],
    ['The answer is 17. Can you explain why?',3],
    ['Could the answer be 17?',3],
    ['你想想，答案会不会是17？',3],
    ['不妨选 C，再说明理由。',3],
    ['Choose option B, then justify your choice.',3],
    ['既然 Δ=1，那么你觉得这里是加还是减？',3],
    ['−4 × 1 × 6 = −24，接下来你能继续吗？',3],
    ['The discriminant equals 1. What do you do next?',3],
    ['go 的过去式是 went。',3],
    ['The past tense of go is went.',3],
  ])('ignores a declared zero when content exposes help: %s',(studentFacingText,level)=>{
    const review=reviewAssistance({studentFacingText,declaredHintLevel:0});
    expect(review.status).toBe('DETECTED');
    expect(review.minimumLevel).toBe(level);
    expect(review.effectiveLevel).toBe(level);
    expect(review.reviewRequired).toBe(true);
    expect(review.reasons).toContain('MODEL_LEVEL_UNDERSPECIFIES_CONTENT');
    expect(JSON.parse(JSON.stringify(review))).toEqual(review);
  });
  it('reviews follow-up text and displayed finding statements, not just the first message',()=>{
    const review=reviewAssistance({studentFacingText:'你这一步是怎么想的？',followUpQuestion:'你能核对一下吗？',
      findings:[{statement:'判别式 Δ=1，原因仍需核实。'}],declaredHintLevel:0});
    expect(review.minimumLevel).toBe(3);
  });
  it('only clears a whole recognised no-help question',()=>{
    expect(reviewAssistance({studentFacingText:'你当时是怎么想的？',followUpQuestion:'你当时是怎么想的？',declaredHintLevel:0})).toMatchObject({status:'CLEAR',minimumLevel:0,effectiveLevel:0});
    expect(reviewAssistance({studentFacingText:'Can you explain your reasoning?',declaredHintLevel:0})).toMatchObject({status:'CLEAR',minimumLevel:0});
    const longer=reviewAssistance({studentFacingText:'你当时是怎么想的？想象天平向左倾斜的情形。',declaredHintLevel:0});
    expect(longer).toMatchObject({status:'UNCERTAIN',minimumLevel:null,effectiveLevel:null,reviewRequired:true});
  });
  it.each(['你能把刚才想到的那个数再说一遍吗？','Imagine the balance tilting left.','新颖比喻或未覆盖学科内容。',''])('keeps unmatched generated content unknown: %s',(studentFacingText)=>{
    expect(reviewAssistance({studentFacingText,declaredHintLevel:0})).toMatchObject({status:'UNCERTAIN',minimumLevel:null,effectiveLevel:null,reviewRequired:true});
  });
  it('never lowers a declared nonzero, even when the actual level cannot be classified',()=>{
    expect(reviewAssistance({studentFacingText:'未覆盖的表达。',declaredHintLevel:2})).toMatchObject({status:'UNCERTAIN',minimumLevel:null,effectiveLevel:2,reviewRequired:true});
    expect(reviewAssistance({studentFacingText:'先检查第二步。',declaredHintLevel:3})).toMatchObject({status:'DETECTED',minimumLevel:1,effectiveLevel:3});
  });
  it('an explicit help event remains help even when returned text is not classifiable',()=>{
    expect(reviewAssistance({studentFacingText:'未覆盖的表达。',declaredHintLevel:0,requestedAction:'HINT'})).toMatchObject({status:'DETECTED',minimumLevel:1,effectiveLevel:1});
  });
  it('does not promote an unrelated original question into a clearance for this question',()=>{
    const general=reviewAssistance({studentFacingText:'你当时是怎么想的？',declaredHintLevel:0});
    expect(recordedPracticeAssistance({hintUsed:false,assistance:general}).independence).toBe('UNKNOWN');
  });
});

describe('question-scoped practice help provenance',()=>{
  it('allows a fresh rule-bank question to remain independent despite help on the diagnosis question',()=>{
    const original=reviewAssistance({studentFacingText:'答案是 1。',declaredHintLevel:0});
    expect(original.effectiveLevel).toBe(3);
    const evidence=recordedPracticeAssistance({hintUsed:false,answerVisibility:'HIDDEN',assistance:knownNoAssistance()});
    const result=evaluatePractice({answerText:'17',answerSpec:{type:'NUMBER',value:17,tolerance:0},assistance:evidence.assistance,assistanceReasons:evidence.reasons});
    expect(evidence.independence).toBe('INDEPENDENT');
    expect(result.masteryState).toBe('PASSED_CURRENT_PROBE');
  });
  it.each([null,undefined,{},'INDEPENDENT',{...knownNoAssistance(),effectiveLevel:2},{...knownNoAssistance(),source:'MODEL'}])('does not assume old/malformed provenance means no help: %j',(assistance)=>{
    const evidence=recordedPracticeAssistance({hintUsed:false,assistance});
    const result=evaluatePractice({answerText:'17',answerSpec:{type:'NUMBER',value:17,tolerance:0},assistance:evidence.assistance,assistanceReasons:evidence.reasons});
    expect(evidence.independence).toBe('UNKNOWN');
    expect(result.correctness).toBe('CORRECT');
    expect(result.independence).toBe('UNKNOWN');
    expect(result.masteryState).toBe('NOT_ENOUGH_EVIDENCE');
    expect(result.feedback).toContain('待确认');
  });
  it('either durable help flag defeats a stale false flag or clearance',()=>{
    expect(recordedPracticeAssistance({hintUsed:true,assistance:knownNoAssistance()}).independence).toBe('ASSISTED');
    expect(recordedPracticeAssistance({hintUsed:false,hintUsedAt:new Date('2026-10-23T00:00:00Z'),assistance:knownNoAssistance()}).independence).toBe('ASSISTED');
  });
  it('a reveal always stays assisted and reports solution exposure',()=>{
    expect(recordedPracticeAssistance({hintUsed:false,answerVisibility:'REVEALED',assistance:knownNoAssistance()})).toMatchObject({assistance:'SOLUTION_VIEWED',independence:'ASSISTED'});
    const actualAnswer=reviewAssistance({studentFacingText:'17 是最终值；答案是17。',declaredHintLevel:0});
    expect(recordedPracticeAssistance({hintUsed:false,assistance:actualAnswer}).assistance).toBe('SOLUTION_VIEWED');
  });
  it('cannot infer independence from an unrecognised visibility state',()=>{
    expect(recordedPracticeAssistance({hintUsed:false,answerVisibility:'UNRECORDED',assistance:knownNoAssistance()}).independence).toBe('UNKNOWN');
  });
  it('preserves stronger content help and uncertainty across repeated recorded events',()=>{
    const high=reviewAssistance({studentFacingText:'答案是17。',declaredHintLevel:0});
    const low=reviewAssistance({studentFacingText:'先检查第二步。',declaredHintLevel:1,requestedAction:'HINT'});
    expect(mergeAssistanceReviews(high,low).effectiveLevel).toBe(3);
    expect(recordedPracticeAssistance({hintUsed:true,assistance:mergeAssistanceReviews(high,low)}).assistance).toBe('SOLUTION_VIEWED');
    const unknown=reviewAssistance({studentFacingText:'未覆盖表达。',declaredHintLevel:0});
    const merged=mergeAssistanceReviews(unknown,knownNoAssistance());
    expect(merged).toMatchObject({status:'UNCERTAIN',minimumLevel:null,effectiveLevel:null,reviewRequired:true});
    expect(parseAssistanceReview(merged)).toEqual(merged);
  });
  it('escalation never resets unknown or actual help to independent',()=>{
    expect(escalateAssistance('UNKNOWN','INDEPENDENT')).toBe('UNKNOWN');
    expect(escalateAssistance('HINTED','UNKNOWN')).toBe('HINTED');
    expect(escalateAssistance('UNKNOWN','SOLUTION_VIEWED')).toBe('SOLUTION_VIEWED');
  });
  it('rejects internally contradictory persisted reviews',()=>{
    expect(parseAssistanceReview({...knownNoAssistance(),reasons:[]})).toBeNull();
    expect(parseAssistanceReview({...knownNoAssistance(),status:'DETECTED'})).toBeNull();
    expect(parseAssistanceReview({...knownNoAssistance(),status:'UNCERTAIN',minimumLevel:null,effectiveLevel:null,reviewRequired:false})).toBeNull();
    expect(parseAssistanceReview({...knownNoAssistance(),status:'UNCERTAIN',minimumLevel:null,effectiveLevel:null,declaredLevel:2,reviewRequired:true})).toBeNull();
  });
});
