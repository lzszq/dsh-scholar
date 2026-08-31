import { defineConfig } from 'tsdown'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const pluginId = '@dsh-scholar/research-ui'
const require = createRequire(import.meta.url)
const XTERM_CSS_REQUEST = '@xterm/xterm/css/xterm.css?inline'
const XTERM_CSS_MODULE = '\0dsh-scholar-xterm-css'

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    // The standalone browser host exposes no npm module loader. Keep the
    // emulator self-contained in client.js and let bundle verification reject
    // any accidental runtime dependency.
    alwaysBundle: [/^@xterm\//, /^@noble\/hashes/, /^@dsh-scholar\/research-schemas\/chat-agent$/, /^zod$/],
    onlyBundle: [/^@xterm\//, /^@noble\/hashes/, /^zod$/],
  },
  plugins: [{
    name: 'dsh-scholar-xterm-css-inline',
    resolveId(id) {
      if (id === XTERM_CSS_REQUEST) return XTERM_CSS_MODULE
      return null
    },
    load(id) {
      if (id !== XTERM_CSS_MODULE) return null
      const cssPath = require.resolve('@xterm/xterm/css/xterm.css')
      return `export default ${JSON.stringify(readFileSync(cssPath, 'utf8'))}`
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
