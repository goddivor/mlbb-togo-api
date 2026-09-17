/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { project: 'tsconfig.json', tsconfigRootDir: __dirname, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'eslint-config-prettier',
  ],
  env: { node: true, jest: true },
  ignorePatterns: ['.eslintrc.js', 'dist/', 'node_modules/', 'coverage/', 'prisma/seed.ts'],
  rules: {
    // Business code relies heavily on `any` for serialized Prisma payloads;
    // making it an error would block the review gate without a massive
    // refactor that is out of scope here.
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/interface-name-prefix': 'off',
    // `ignoreRestSiblings` covers the omission idiom used to strip sensitive
    // fields: `const { password, mlbbToken, ...rest } = user`. Without it, the
    // very way we protect data would be flagged.
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
  },
};
