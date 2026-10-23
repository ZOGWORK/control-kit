import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '.pnpm-store/**', '.wrangler/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
