import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "off",
      // stdout is the MCP channel under the stdio transport; logging must go
      // through the stderr helper in index.ts instead.
      "no-console": "error",
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      // Fixtures and fakes legitimately reach for non-null assertions.
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
