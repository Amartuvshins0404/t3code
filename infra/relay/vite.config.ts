import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";

const { run: _rootRunConfig, ...basePackageConfig } = baseConfig;

export default mergeConfig(
  basePackageConfig,
  defineConfig({
    pack: {
      entry: ["src/node.ts"],
      outDir: "dist",
      clean: true,
      platform: "node",
      sourcemap: true,
      deps: {
        alwaysBundle: () => true,
        neverBundle: ["pg-native"],
        onlyBundle: false,
      },
    },
  }),
);
