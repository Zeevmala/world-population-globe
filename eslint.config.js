import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // `.claude/worktrees/*` holds throwaway checkouts of this same repo; each carries its
  // own tsconfig, which makes the type-aware parser refuse to guess a root directory.
  globalIgnores(['dist', '.claude/**', '**/scripts/qa/out/**']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      // Pin the root explicitly so a nested checkout can never make it ambiguous.
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
])
