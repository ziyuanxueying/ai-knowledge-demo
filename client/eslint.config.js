import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * ESLint 9 Flat Config
 *
 * 配置 react-hooks 插件后，代码中的 // eslint-disable-next-line react-hooks/exhaustive-deps
 * 注释就能正常生效，useEffect 的依赖数组警告也能被正确处理。
 */
export default [
  // 忽略目录
  {
    ignores: ['dist/**', 'node_modules/**'],
  },

  // JS 推荐规则
  js.configs.recommended,

  // 项目自定义配置
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      // React 推荐规则
      ...react.configs.recommended.rules,

      // React Hooks 推荐规则（包含 exhaustive-deps 和 rules-of-hooks）
      ...reactHooks.configs.recommended.rules,

      // 关闭不需要的规则
      'react/react-in-jsx-scope': 'off', // Vite 不需要手动 import React
      'react/prop-types': 'off', // 不使用 PropTypes

      // 未使用变量：警告而非报错（函数参数允许未使用）
      'no-unused-vars': ['warn', { args: 'after-used', vars: 'all' }],
    },
  },
];
