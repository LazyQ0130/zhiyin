/** Fail closed on malformed limits instead of disabling a quota via NaN. */
export function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid server configuration: ${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid server configuration: ${name}`);
  return value;
}

export function aliyunEndpoint(baseUrl: string): string {
  const base = new URL(baseUrl);
  const legacy = ['dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com','dashscope-us.aliyuncs.com'];
  const workspace = /^[a-z0-9-]+\.(?:cn-beijing|ap-southeast-1|us-east-1|eu-central-1|ap-northeast-1|cn-hongkong)\.maas\.aliyuncs\.com$/;
  if (base.protocol !== 'https:' || !(legacy.includes(base.hostname) || workspace.test(base.hostname))
      || base.port || base.username || base.password || base.search || base.hash
      || !/^\/compatible-mode\/v1\/?$/.test(base.pathname)) throw new Error('Invalid official Aliyun endpoint');
  return `${base.origin}/compatible-mode/v1/chat/completions`;
}
