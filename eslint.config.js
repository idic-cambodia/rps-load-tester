import js from "@eslint/js";
export default [
  { ignores: ["node_modules/**", "data/**", "generated/**", "coverage/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        fetch: "readonly",
        AbortSignal: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        console: "readonly",
      },
    },
    rules: { "no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
  },
  {
    files: ["web/public/**/*.js"],
    languageOptions: {
      globals: {
        document: "readonly",
        location: "readonly",
        fetch: "readonly",
        FormData: "readonly",
        confirm: "readonly",
        io: "readonly",
        window: "readonly",
        ResizeObserver: "readonly",
      },
    },
  },
];
