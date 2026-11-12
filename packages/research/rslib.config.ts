import { defineConfig } from "@rslib/core";

export default defineConfig({
  lib: [
    {
      format: "esm",
      syntax: "es2024",
      bundle: false,
      dts: false,
      source: { entry: { index: ["./src/**/*.ts"] } },
      output: { target: "node", externals: [/^@deepseek-ai\//, /^@tack\//, /^zod/] },
    },
  ],
  output: { distPath: { root: "./lib" }, cleanDistPath: true },
});
