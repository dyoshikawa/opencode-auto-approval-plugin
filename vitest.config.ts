import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    watch: false,
    typecheck: {
      enabled: false,
      include: ["src/**/*.test-d.ts"],
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.test-d.ts"],
    },
  },
});
