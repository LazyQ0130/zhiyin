import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { annotationSetSchema, evaluationDatasetSchema, evaluationRunSchema, hashValue, outputReviewSetSchema } from "../../src/evaluation/schemas";
import { scoreEvaluation } from "../../src/evaluation/score";

async function json(file:string) {return JSON.parse(await readFile(path.resolve(file),"utf8")) as unknown;}
const [command,...args]=process.argv.slice(2);
try {
  if(command==="validate") {
    const dataset=evaluationDatasetSchema.parse(await json(args[0]??"tests/evaluation/engineering.inputs.json"));
    const annotation=args[1]?annotationSetSchema.parse(await json(args[1])):undefined;
    if(annotation&&(annotation.datasetId!==dataset.datasetId||annotation.datasetVersion!==dataset.version||annotation.datasetHash!==hashValue(dataset)))throw new Error("ANNOTATION_DATASET_MISMATCH");
    // Binding and scoped-gold validation are shared with scoring, including empty runs.
    if(annotation)scoreEvaluation(dataset,{schemaVersion:"1.0",runId:"validation-only",createdAt:new Date().toISOString(),datasetId:dataset.datasetId,datasetVersion:dataset.version,datasetHash:hashValue(dataset),caseIds:dataset.cases.map(c=>c.id),mode:"SIMULATED",provider:"none",model:"none",promptVersion:"none",records:[]},annotation);
    console.log(JSON.stringify({status:"VALID",datasetId:dataset.datasetId,cases:dataset.cases.length,datasetHash:hashValue(dataset),teacherReviewed:annotation?.annotations.filter(a=>a.provenance==="TEACHER_REVIEWED").length??0}));
  } else if(command==="score") {
    if(!args[0]||!args[1])throw new Error("用法: offline.ts score <inputs.json> <run.json> [annotations.json] [output-reviews.json]");
    const dataset=await json(args[0]),run=evaluationRunSchema.parse(await json(args[1])),annotations=args[2]?await json(args[2]):undefined,reviews=args[3]?outputReviewSetSchema.parse(await json(args[3])):undefined;
    const report=scoreEvaluation(dataset,run,annotations,reviews);
    const output=path.resolve(".local","m6-evaluation",`score-${new Date().toISOString().replace(/[:.]/g,"-")}-${randomUUID()}`);
    await mkdir(output,{recursive:true});await writeFile(path.join(output,"score.json"),JSON.stringify(report,null,2)+"\n",{flag:"wx"});
    console.log(JSON.stringify({status:report.reliability.failed?"HAS_FAILURES":"SCORED",reportPath:path.join(output,"score.json"),reliability:report.reliability,teacherComparison:report.teacherComparison,cost:report.cost}));
    if(report.reliability.failed)process.exitCode=1;
  } else if(command==="label-hash") {
    if(!args[0])throw new Error("用法: offline.ts label-hash <expected-or-ratings.json>");
    console.log(hashValue(await json(args[0])));
  } else if(command==="prepare-output-reviews") {
    if(!args[0]||!args[1])throw new Error("用法: offline.ts prepare-output-reviews <inputs.json> <run.json>");
    const dataset=evaluationDatasetSchema.parse(await json(args[0])),run=evaluationRunSchema.parse(await json(args[1]));
    scoreEvaluation(dataset,run);
    const output=path.resolve(".local","m6-evaluation",`output-review-drafts-${randomUUID()}`);await mkdir(output,{recursive:true});
    const draft={schemaVersion:"1.0",runId:run.runId,reviews:run.records.filter(r=>r.status==="SUCCESS").map(r=>({caseId:r.caseId,inputHash:r.inputHash,outputHash:hashValue(r.output),ratings:{reasonCorrectness:null,followUpEffectiveness:null,evidenceRelevance:null,rationale:"待教师盲审；null不计质量分。"},review:{status:"DRAFT",independentReviews:[]}}))};
    for(const name of ["reviewer-a.json","reviewer-b.json"])await writeFile(path.join(output,name),JSON.stringify(draft,null,2)+"\n",{flag:"wx"});
    console.log(JSON.stringify({status:"UNREVIEWED_OUTPUT_DRAFTS",output}));
  } else if(command==="prepare-teacher") {
    const dataset=evaluationDatasetSchema.parse(await json(args[0]??"tests/evaluation/engineering.inputs.json"));
    const output=path.resolve(".local","m6-evaluation",`teacher-drafts-${randomUUID()}`);await mkdir(output,{recursive:true});
    const draft={schemaVersion:"1.0",datasetId:dataset.datasetId,datasetVersion:dataset.version,datasetHash:hashValue(dataset),annotations:dataset.cases.map(c=>({caseId:c.id,inputHash:hashValue(c.context),provenance:"ENGINEERING_PROVISIONAL",expected:{acceptableStepIdSets:null,acceptableCategorySets:null,allowedActions:["MARK_INCONCLUSIVE"],requiresAbstention:null,noErrorExpected:false,requiredEvidence:[],rationale:"待教师独立标注；此处仅为可解析模板，不是预设答案。"},review:{status:"DRAFT",independentReviews:[]}}))};
    // Separate identical blank packets: teachers must work independently; never call these gold before review.
    for(const name of ["reviewer-a.json","reviewer-b.json"])await writeFile(path.join(output,name),JSON.stringify(draft,null,2)+"\n",{flag:"wx"});
    console.log(JSON.stringify({status:"UNREVIEWED_DRAFTS",output,notice:"独立填写并签收后才可升级为TEACHER_REVIEWED。模板默认值不计教师金标。"}));
  } else throw new Error("用法: offline.ts validate|score|prepare-teacher|prepare-output-reviews|label-hash ...；所有命令均离线，不调用模型。");
} catch(error) {console.error(JSON.stringify({status:"FAILED",error:error instanceof Error?error.message:"UNKNOWN"}));process.exitCode=2;}
