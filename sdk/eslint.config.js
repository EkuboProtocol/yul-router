import tsParser from "@typescript-eslint/parser";

const rules = { complexity: ["error", 10] };

export default [
  {
    ignores: ["node_modules/**", "dist/**", "build/**", ".astro/**", "generated/**"],
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" },
    },
    rules,
  },
  {
    files: ["**/*.{js,jsx,mjs}"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules,
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { ecmaVersion: "latest", sourceType: "commonjs" },
    rules,
  },
];
