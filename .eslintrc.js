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
    // Le code métier s'appuie largement sur `any` pour les payloads Prisma
    // sérialisés ; en faire une erreur rendrait la porte de review
    // infranchissable sans un refactor massif, hors sujet ici.
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/interface-name-prefix': 'off',
    // `ignoreRestSiblings` couvre l'idiome d'omission utilise pour retirer les
    // champs sensibles : `const { password, mlbbToken, ...rest } = user`. Sans
    // lui, la facon meme dont on protege les donnees serait signalee.
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
  },
};
