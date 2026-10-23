import {readFileSync,writeFileSync} from 'node:fs';
/** Next adds its timestamped build paths; keep machine-specific output paths out of the baseline. */
export function normalizeTypescript(){
  const config=JSON.parse(readFileSync('tsconfig.json','utf8'));
  config.include=['next-env.d.ts','src/**/*.ts','src/**/*.tsx','scripts/**/*.ts','tests/**/*.ts','*.ts','.next/types/**/*.ts','.next/dev/types/**/*.ts'];
  writeFileSync('tsconfig.json',JSON.stringify(config,null,2)+'\n');
}
