/**
 * Airbnb TypeScript 风格 —— 用户指定。
 *
 * 说明：airbnb-typescript 需要 parserOptions.project 才能启用类型感知规则
 * （consistent-type-imports、no-floating-promises 等），因此这里指向 tsconfig.json。
 */
module.exports = {
  root: true,
  env: { node: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: './tsconfig.json',
  },
  plugins: ['@typescript-eslint', 'import', 'prettier'],
  extends: [
    'airbnb-base',
    'airbnb-typescript/base',
    'plugin:@typescript-eslint/recommended-type-checked',
    'plugin:import/typescript',
    'prettier',
  ],
  settings: {
    'import/resolver': {
      typescript: { project: './tsconfig.json' },
      node: { extensions: ['.js', '.ts'] },
    },
  },
  rules: {
    // 类型安全优先：禁止 any（有正当理由时单行 disable 并写明原因）
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unsafe-assignment': 'error',
    '@typescript-eslint/no-unsafe-member-access': 'error',
    '@typescript-eslint/no-unsafe-call': 'error',
    '@typescript-eslint/no-unsafe-return': 'error',
    // 统一用 `import type` / `export type`，避免运行时多打一个 import
    '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    // 异步：Promise 不允许飘着（Python 侧最容易漏的正是这一条）
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
    'no-restricted-syntax': ['error', 'WithStatement'],

    // ---- 有意关闭的 Airbnb 规则（逐条说明原因）----
    'import/prefer-default-export': 'off',
    'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],

    // IP 子网掩码、哈希分桶必须用位运算（src/security/ip.ts），无替代写法
    'no-bitwise': 'off',
    // Python 侧大量 `continue`（跳过不合规项），直译成 if 嵌套反而更难读
    'no-continue': 'off',
    // 本项目的循环体多为「必须串行」的 SSH/DB 调用，改成 Promise.all 会改变语义
    'no-await-in-loop': 'off',
    // Fastify 的 handler/preHandler 签名要求返回 Promise，函数体不 await 也得是 async
    '@typescript-eslint/require-await': 'off',
    // `void promise` 是官方推荐的「显式忽略」写法，比 .catch(()=>{}) 更直白
    'no-void': 'off',
    // 分发表（如 EXT_REVIEWERS）常引用后面定义的箭头常量，改用函数声明会破坏风格统一
    '@typescript-eslint/no-use-before-define': ['error', { functions: false, variables: false }],
    // 循环内闭包捕获的循环变量在本项目中均不再被外部改写
    '@typescript-eslint/no-loop-func': 'off',

    // ESM 下每个相对 import 必须带 .js 后缀（NodeNext 要求）
    'import/extensions': ['error', 'ignorePackages', { ts: 'never', js: 'always' }],
  },
  overrides: [
    {
      files: ['scripts/**/*.ts', 'src/cli.ts'],
      rules: { 'no-console': 'off' },
    },
    {
      // 测试文件不在 tsconfig.json 的 include 里，类型感知规则需指向 tsconfig.test.json
      files: ['tests/**/*.ts', 'vitest.config.ts'],
      parserOptions: { project: './tsconfig.test.json' },
      rules: {
        // 测试里用 devDependencies（vitest / pglite 等）是常态
        'import/no-extraneous-dependencies': 'off',
        // 一个文件里放多个替身类（FakeSftp / FakeClient…）比拆文件更好读
        'max-classes-per-file': 'off',
        // 替身类必须实现完整接口，很多方法天然不用 this
        'class-methods-use-this': 'off',
      },
    },
  ],
};
