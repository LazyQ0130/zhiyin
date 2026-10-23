import type {DiagnosisContext} from '../server/ai/gateway';
import {diagnosisTurnSchema} from '../server/ai/schemas/diagnosis';
import {validateDiagnosisTurn} from '../server/ai/validate-turn';
import {reviewAssistance} from '../server/domain/assistance-review';

/** Offline regression only. Return audit metadata, never copy historical response text. */
export function replayM7Protocol(context:DiagnosisContext,value:unknown){
  const original=diagnosisTurnSchema.parse(value);
  const guarded=validateDiagnosisTurn(original,context);
  const help=reviewAssistance({studentFacingText:guarded.studentFacingText,followUpQuestion:guarded.followUpQuestion,findings:guarded.findings,declaredHintLevel:guarded.hintLevel,subject:context.subject,questionText:context.questionText});
  const causes=guarded.findings.filter(f=>f.category==='KNOWLEDGE');
  const initial=guarded.findings.find(f=>f.trust?.rootCause.role==='INITIAL');
  const propagated=guarded.findings.filter(f=>f.trust?.rootCause.role==='PROPAGATED');
  const checks={
    unsupportedCauseCannotBecomeFact:causes.length>0&&causes.every(f=>f.trust?.kind!=='VERIFIED'&&f.status!=='VERIFIED'&&f.verificationNeeded),
    nonzeroHelpDespiteDeclaredZero:original.hintLevel===0&&help.status==='DETECTED'&&(help.minimumLevel??0)>=2,
    downstreamSharesCandidateRoot:!!initial&&propagated.length>0&&propagated.every(f=>f.trust?.rootCause.candidateRootId===initial.trust?.rootCause.candidateRootId),
  };
  return {mode:'LOCAL_HISTORICAL_REPLAY' as const,networkRequests:0,newCostCny:0,checks,allGuardsPassed:Object.values(checks).every(Boolean),
    declaredHelpLevel:original.hintLevel,helpReview:help,
    findings:guarded.findings.map(f=>({findingKey:f.findingKey,status:f.status,kind:f.trust?.kind,verificationNeeded:f.verificationNeeded,rootCause:f.trust?.rootCause})),
    educationalQuality:'NOT_EVALUATED' as const,teacherReviewedCases:0};
}
