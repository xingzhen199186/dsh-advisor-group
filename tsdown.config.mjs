import { defineConfig } from 'tsdown'

const ID = 'dsh-advisor-group'
// The browser bundle must leave React to the module-loader runtime.
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime']

export default defineConfig([
  {
    name: ID,
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    dts: true,
    clean: true,
    sourcemap: false,
    outDir: 'lib',
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    sourcemap: false,
    // rewrites it to a backtick template string, which dsh-startup-guard's
    // registration regex (["'] only) cannot match and auto-disables the plugin.
    minify: false,
    deps: {
      neverBundle: CLIENT_EXTERNALS,
      alwaysBundle: (id) => !CLIENT_EXTERNALS.includes(id),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      codeSplitting: false,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
