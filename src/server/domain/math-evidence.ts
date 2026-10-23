/** Bounded arithmetic evidence, not a general algebra system. No eval, dynamic code, or approximate text matching. */
export interface MathStepRelation {
  stepId: string;
  role: "INITIAL" | "PROPAGATED" | "INDEPENDENT" | "UNKNOWN";
  upstreamStepIds: string[];
  reason: string;
}
type Step = { id: string; text: string };
const MAX_VALUE = 1e12;
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b));
function normalized(text: string) {
  return text.replace(/²/g, "^2").normalize("NFKC").replace(/\s/g, "").replace(/[−–﹣]/g, "-").replace(/[×·]/g, "*").replace(/÷/g, "/").replace(/[Δδ]/g, "delta").toLowerCase();
}

/** Only numbers, bounded names, parentheses, sqrt, and arithmetic operators are accepted. */
export function evaluateBoundedArithmetic(expression: string, variables: Readonly<Record<string, number>> = {}): number | null {
  const source = normalized(expression).replace(/√(?=\()/g, "sqrt");
  if (!source || source.length > 240) return null;
  const tokens = source.match(/\d+(?:\.\d+)?|\.\d+|[a-z][a-z0-9_]{0,19}|[()+*/^\-]/g) ?? [];
  if (tokens.join("") !== source || tokens.length > 100) return null;
  let position = 0;
  let depth = 0;
  const bounded = (value: number) => { if (!Number.isFinite(value) || Math.abs(value) > MAX_VALUE) throw new Error("BOUND"); return value; };
  const atom = (): number => {
    if (++depth > 12) throw new Error("DEPTH");
    const token = tokens[position++];
    let value: number;
    if (token === "(" || token === "sqrt") {
      if (token === "sqrt" && tokens[position++] !== "(") throw new Error("SQRT");
      value = sum();
      if (tokens[position++] !== ")") throw new Error("PAREN");
      if (token === "sqrt") value = Math.sqrt(value);
    } else if (token && /^(?:\d|\.)/.test(token)) value = Number(token);
    else if (token && Object.hasOwn(variables, token)) value = variables[token];
    else throw new Error("TOKEN");
    depth--;
    return bounded(value);
  };
  const power = (): number => {
    let value = atom();
    if (tokens[position] === "^") {
      position++;
      const exponent = unary();
      if (!Number.isInteger(exponent) || Math.abs(exponent) > 8) throw new Error("EXPONENT");
      value = bounded(value ** exponent);
    }
    return value;
  };
  const unary = (): number => {
    if (tokens[position] === "+" || tokens[position] === "-") {
      const operator = tokens[position++];
      if (++depth > 12) throw new Error("DEPTH");
      const value = (operator === "-" ? -1 : 1) * unary();
      depth--;
      return bounded(value);
    }
    return power();
  };
  const product = (): number => {
    let value = unary();
    while (tokens[position] === "*" || tokens[position] === "/") {
      const operator = tokens[position++];
      const right = unary();
      if (operator === "/" && right === 0) throw new Error("ZERO");
      value = bounded(operator === "*" ? value * right : value / right);
    }
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (tokens[position] === "+" || tokens[position] === "-") {
      const operator = tokens[position++];
      const right = product();
      value = bounded(operator === "+" ? value + right : value - right);
    }
    return value;
  };
  try { const value = sum(); return position === tokens.length ? value : null; }
  catch { return null; }
}

/** Conservative polynomial recognizer: one integer-coefficient quadratic equation, bounded coefficients. */
export function parseQuadraticQuestion(question: string): { a: number; b: number; c: number } | null {
  const source = normalized(question);
  const matches = [...source.matchAll(/(?<![\da-z^])([+-]?\d*)x\^2([+-]\d*)x([+-]\d+)=0/g)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const coefficient = (value: string) => value === "" || value === "+" ? 1 : value === "-" ? -1 : Number(value);
  const [a, b, c] = [coefficient(match[1]), coefficient(match[2]), Number(match[3])];
  if (a === 0 || [a, b, c].some(value => !Number.isSafeInteger(value) || Math.abs(value) > 10000)) return null;
  // Additional equalities/equations make the selected rule ambiguous.
  if ((source.match(/=0/g) ?? []).length !== 1) return null;
  return { a, b, c };
}

export function deriveMathStepRelations(input: { subject: string; questionText: string; steps: Step[] }): MathStepRelation[] {
  if (input.subject !== "MATH" || input.steps.length > 40) return [];
  const variables: Record<string, number> = Object.create(null);
  const tainted = new Map<string, string[]>();
  const relations = new Map<string, MathStepRelation>();
  const quadratic = parseQuadraticQuestion(input.questionText);
  let wrongDelta: { value: number; stepId: string } | null = null;
  let errors = 0;
  for (const step of input.steps) {
    const text = normalized(step.text);
    if (text.length > 2000) continue;
    const segments = text.split(/[，,;；。]/);
    for (const segment of segments) {
      const assignment = /^(?:判别式)?([a-z][a-z0-9_]{0,19})=(.+)$/.exec(segment);
      if (!assignment) continue;
      const [, name, chain] = assignment;
      const parts = chain.split("=");
      if (parts.length > 5 || parts.some(part => !part)) continue;
      const values = parts.map(part => evaluateBoundedArithmetic(part, variables));
      if (values.some(value => value === null)) continue;
      const result = values.at(-1)!;
      const dependencies = [...new Set((parts[0].match(/[a-z][a-z0-9_]{0,19}/g) ?? []).flatMap(variable => tainted.get(variable) ?? []))];
      const localWrong = values.some(value => !near(value!, result));
      const expectedDelta = quadratic ? quadratic.b ** 2 - 4 * quadratic.a * quadratic.c : null;
      const ruleWrong = (name === "delta" && expectedDelta !== null && !near(result, expectedDelta)) || (quadratic !== null && ["a", "b", "c"].includes(name) && !near(result, quadratic[name as "a" | "b" | "c"]));
      if (localWrong || (ruleWrong && !dependencies.length)) {
        relations.set(step.id, { stepId: step.id, role: errors++ === 0 ? "INITIAL" : "INDEPENDENT", upstreamStepIds: [], reason: localWrong ? "该等式的局部算术不成立。" : "所写判别式与题干系数的确定性规则不一致。" });
        tainted.set(name, [step.id]);
      } else if (dependencies.length) {
        relations.set(step.id, { stepId: step.id, role: "PROPAGATED", upstreamStepIds: dependencies, reason: "局部算术沿用了前步的错误中间量；尚无第二个独立错误的证据。" });
        tainted.set(name, dependencies);
      } else {
        tainted.delete(name);
        if (!relations.has(step.id)) relations.set(step.id, { stepId: step.id, role: "UNKNOWN", upstreamStepIds: [], reason: "所写局部等式在受限算术范围内自洽；没有由此确认错误或因果关系。" });
      }
      variables[name] = result;
      if (name === "delta" && ruleWrong) wrongDelta = { value: result, stepId: step.id };
    }
    // A quadratic-formula substitution can propagate an incorrect discriminant even when written numerically.
    if (quadratic && wrongDelta?.stepId !== step.id) {
      const rootExpression = /(?:^|[;；,，])x=([^=，,;；。]+?)(?:[,，;；]?(?:所以|因此)|$)/.exec(text)?.[1];
      if (!rootExpression || !rootExpression.includes("±")) continue;
      const actual = [evaluateBoundedArithmetic(rootExpression.replace("±", "+")), evaluateBoundedArithmetic(rootExpression.replace("±", "-"))];
      const correctDelta = quadratic.b ** 2 - 4 * quadratic.a * quadratic.c;
      const correctRoots = [(-quadratic.b + Math.sqrt(correctDelta)) / (2 * quadratic.a), (-quadratic.b - Math.sqrt(correctDelta)) / (2 * quadratic.a)];
      const claimed = /(?:所以|因此)x=([+-]?[\d.]+)或(?:x=)?([+-]?[\d.]+)$/.exec(text);
      const agreesWith = (expected: number[]) => !claimed || [Number(claimed[1]), Number(claimed[2])].sort((a, b) => a - b).every((value, index) => near(value, [...expected].sort((a, b) => a - b)[index]));
      if (correctDelta >= 0 && actual.every((value, index) => value !== null && near(value, correctRoots[index])) && agreesWith(correctRoots)) {
        relations.set(step.id, { stepId: step.id, role: "UNKNOWN", upstreamStepIds: [], reason: "本步求根代入与题干系数的确定性规则一致，不能据此编造错误。" });
        continue;
      }
      if (!wrongDelta || wrongDelta.value < 0) continue;
      const expected = [(-quadratic.b + Math.sqrt(wrongDelta.value)) / (2 * quadratic.a), (-quadratic.b - Math.sqrt(wrongDelta.value)) / (2 * quadratic.a)];
      if (actual.every((value, index) => value !== null && near(value, expected[index]))) {
        const selfConsistent = agreesWith(expected);
        relations.set(step.id, selfConsistent
          ? { stepId: step.id, role: "PROPAGATED", upstreamStepIds: [wrongDelta.stepId], reason: "按所写错误判别式代入求根公式时，后步算术自洽；应归为前错传播。" }
          : { stepId: step.id, role: "INDEPENDENT", upstreamStepIds: [], reason: "除前步错误判别式外，本步局部求根算术也不成立。" });
      }
    }
  }
  return [...relations.values()];
}
