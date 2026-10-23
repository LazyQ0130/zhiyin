import "dotenv/config";
import {defineConfig} from "vitest/config";
import {fileURLToPath} from "node:url";

export default defineConfig({
  resolve:{alias:{
    "@":fileURLToPath(new URL("./src",import.meta.url)),
    "server-only":fileURLToPath(new URL("./tests/unit/domain-server-only-shim.ts",import.meta.url)),
  }},
  test:{include:["tests/service/**/*.test.ts"],environment:"node",testTimeout:15000,hookTimeout:15000,fileParallelism:false},
});
