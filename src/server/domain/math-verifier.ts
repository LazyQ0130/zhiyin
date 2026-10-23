/** Restricted arithmetic only: never evaluates student-provided code or expressions. */
export function verifyQuadratic(a: number, b: number, c: number) {
  if (![a, b, c].every(Number.isFinite) || a === 0 || [a, b, c].some(n => Math.abs(n) > 1e6)) {
    throw new Error("INVALID_QUADRATIC_COEFFICIENTS");
  }
  const discriminant = b * b - 4 * a * c;
  const roots = discriminant < 0 ? [] : [(-b - Math.sqrt(discriminant)) / (2 * a), (-b + Math.sqrt(discriminant)) / (2 * a)];
  return { discriminant, negativeFourAC: -4 * a * c, roots: [...new Set(roots)].sort((x, y) => x - y) };
}

export function normalizeMath(text: string): string {
  return text.normalize("NFKC").replace(/\s/g, "").replace(/[−–﹣]/g, "-").replace(/[×·]/g, "*").replace(/[，、]/g, ",").replace(/²/g, "2").toLowerCase();
}
export function isDemoQuadratic(question: string): boolean {
  const normalized = normalizeMath(question).replace(/x\^2/g, "x2");
  return /^(?:解(?:一元二次)?方程|解|求解)?x2-5x\+6=0[。.?？]*$/.test(normalized);
}
export function isDemoReading(question: string): boolean {
  const normalized = question.replace(/\s/g, "");
  return /^某活动报名要求至少满12周岁[。.]学生甲满12周岁[，,]是否符合年龄要求[？?]?$/.test(normalized);
}
export function parseNumericAnswer(value: string): number | null {
  const normalized = normalizeMath(value).replace(/^(?:δ|判别式|答案)[:：=]?/, "").replace(/[。.]$/, "");
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\/[+-]?\d+(?:\.\d+)?)?$/.test(normalized)) return null;
  const parts = normalized.split("/").map(Number);
  const result = parts.length === 1 ? parts[0] : parts[0] / parts[1];
  return typeof result === "number" && Number.isFinite(result) ? result : null;
}

export function inspectDemoSteps(steps: Array<{ id: string; text: string }>) {
  const wrongDiscriminant = steps.find(step => {
    const s = normalizeMath(step.text);
    return /(?:δ|判别式)=.*(?:25\+24|=49)/.test(s) || /(?:δ|判别式)=49(?:$|[。;；])/.test(s);
  });
  const correctDiscriminant = steps.find(step => {
    const s = normalizeMath(step.text);
    return /(?:δ|判别式)=.*(?:=1)(?:$|[。;；])/.test(s) || /(?:δ|判别式)=1$/.test(s);
  });
  const correctRoots = steps.find(step => /x1=3,x2=2|x1=2,x2=3|x=2或x=3|x=3或x=2/.test(normalizeMath(step.text)));
  return { wrongDiscriminant, correctDiscriminant, correctRoots };
}
