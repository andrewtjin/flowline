import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Lean flat config: non-type-checked recommended rules (fast, no project service).
export default tseslint.config(
  { ignores: ["dist", "out", "node_modules", ".vite", "*.config.*", ".schema-hash"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
