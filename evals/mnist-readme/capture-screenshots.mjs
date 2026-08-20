import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

const url = process.env.DSH_SCHOLAR_STANDALONE_URL ?? 'http://127.0.0.1:18620/'
const projectId = process.env.DSH_SCHOLAR_PROJECT_ID
if (projectId === undefined || projectId === '') throw new Error('DSH_SCHOLAR_PROJECT_ID is required')
const outputDir = resolve(process.env.DSH_SCHOLAR_SCREENSHOT_DIR ?? 'docs/assets')
mkdirSync(outputDir, { recursive: true })

const chrome = process.env.CHROME_BIN
  ?? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find(existsSync)
if (chrome === undefined) throw new Error('Chrome was not found; set CHROME_BIN')

const profile = mkdtempSync(join(tmpdir(), 'dsh-scholar-mnist-capture-'))
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
const reservePort = async () => await new Promise((resolvePromise, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (address === null || typeof address === 'string') return reject(new Error('Could not reserve a debug port'))
    server.close(error => error === undefined ? resolvePromise(address.port) : reject(error))
  })
})
const waitFor = async (probe, description, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

const port = await reservePort()
const child = spawn(chrome, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--window-size=1920,1080',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' })

let socket
try {
  const target = await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      return targets.find(candidate => candidate.type === 'page')
    } catch { return undefined }
  }, 'Chrome target')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener('open', resolvePromise, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    if (message.id === undefined) return
    const waiter = pending.get(message.id)
    if (waiter === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  const send = (method, params = {}) => new Promise((resolvePromise, reject) => {
    const id = nextId++
    pending.set(id, { resolve: resolvePromise, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.text ?? 'Browser evaluation failed')
    return result.result.value
  }
  const rootExpression = `([...document.querySelectorAll('*')].find(node => node.shadowRoot)?.shadowRoot)`
  const selectProject = async () => {
    await waitFor(() => evaluate(`(() => {
      const root=${rootExpression}; if (!root) return false
      const item=[...root.querySelectorAll('.ws-item')].find(node => node.title.includes('${projectId}'))
      if (!(item instanceof HTMLElement)) return false
      item.click(); return true
    })()`), `project ${projectId}`)
    await waitFor(() => evaluate(`(() => {
      const root=${rootExpression}; return root?.querySelector('.project-title .pid')?.textContent?.includes('${projectId}') === true
    })()`), 'selected project header')
  }
  const capture = async (locale, tab, fileStem) => {
    await evaluate(`localStorage.setItem('dsh-scholar-ui-token', 'mnist-readme-capture'); localStorage.setItem('dsh.locale', ${JSON.stringify(locale)}); location.reload()`)
    await waitFor(() => evaluate('document.readyState === "complete"'), `${locale} reload`)
    await selectProject()
    await evaluate(`location.hash='#tab=${tab}'`)
    await waitFor(() => evaluate(`(() => {
      const root=${rootExpression}; const body=root?.querySelector('.body');
      return body?.dataset.panel === '${tab}' && root?.querySelector('.project-title .pid')?.textContent?.includes('${projectId}') === true
    })()`), `${locale} ${tab} panel`)
    await sleep(800)
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = join(outputDir, `${fileStem}-${locale}.png`)
    writeFileSync(file, Buffer.from(result.data, 'base64'))
    console.log(file)
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url })
  await waitFor(() => evaluate('document.readyState === "complete"'), 'initial page load')

  for (const locale of ['en', 'zh']) {
    await capture(locale, 'phase', 'cnn-mnist-actual-overview')
    await capture(locale, 'runs', 'cnn-mnist-actual-runs')
    await capture(locale, 'evidence', 'cnn-mnist-actual-evidence')
  }
} finally {
  if (socket !== undefined) socket.close()
  child.kill('SIGTERM')
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
