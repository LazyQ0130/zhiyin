import {authorizeLive,type LivePermit} from './live-control';
export const SINGLE_PROTOCOL_DATASET='m7-single-protocol-only';
export const SINGLE_PROTOCOL_CASE='m7-protocol-sign';
export function authorizeSingleProtocol(value:unknown,datasetId:string,datasetHash:string,caseIds:string[],now=new Date()):LivePermit {
  if(datasetId!==SINGLE_PROTOCOL_DATASET||caseIds.length!==1||caseIds[0]!==SINGLE_PROTOCOL_CASE)throw new Error('SINGLE_PROTOCOL_SELECTION_REQUIRED');
  const permit=authorizeLive(value,datasetHash,caseIds,now);
  if(permit.maxRequests!==1)throw new Error('SINGLE_PROTOCOL_ONE_REQUEST_ONLY');
  return permit;
}
