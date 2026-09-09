import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', '.wrangler/**', 'node_modules/**'] },
  { files: ['**/*.{js,mjs}'], ...js.configs.recommended, languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  ...tseslint.configs.recommended.map(config => ({ ...config, files: ['**/*.{ts,tsx}'] })),
  { files: ['**/*.{ts,tsx}'], languageOptions: { globals: { ...globals.node, ...globals.browser } }, rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } },
);
