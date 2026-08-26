/**
 * i18n-runtime (docs/acceptance-tests.md §8, UI-02 / §4 row 99):
 *
 *   tab/pipeline/modal/Terminal/状态 pill 文案必须在 locale 切换后重新求值；
 *   缺 key 在开发模式 warning；zh/en 两套完整切换。
 *
 * Runs inside the ROOT vitest run (tests/unit/**) against the pure logic
 * layer of the research-ui client — the i18n adapter, the chrome-copy model
 * (i18n/chrome.ts) and the pipeline/status label model (ui.ts) — with NO
 * DOM: setLocale() drives listeners/revision/overlay registry, and every
 * chrome source re-evaluates t() against the CURRENT locale at call time,
 * which is exactly what the DOM layer re-paints on locale switch.
 *
 * The static zh/en parity assertion from i18n-chrome.test.ts is kept (the
 * runtime suite re-asserts it so both gates live with the runtime tests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getLocale, getLocaleRevision, localeParityReport, pickLocale, registerOverlayRebuild,
  relocalizeOpenOverlays, resetMissingKeyWarnings, setLocale, setMissingKeyReporter,
  subscribeLocale, t, unregisterOverlayRebuild,
} from '../../packages/dsh-research-ui/src/client/i18n/index'
import { chromeModelChoices, chromeTabGroups, chromeTabs } from '../../packages/dsh-research-ui/src/client/i18n/chrome'
import { CHAT_COMMANDS } from '../../packages/dsh-research-ui/src/client/modals/commands'
import { phasePipeline, statusLabel } from '../../packages/dsh-research-ui/src/client/ui'

describe('live model selector capability projection', () => {
  it('marks image-only models unavailable for Scholar Chat while marking text+image models as visual', () => {
    const choices = chromeModelChoices([
      { id: 'lab/image-only', name: 'Image Only', input_modalities: ['image'] },
      { id: 'lab/empty', name: 'Empty', input_modalities: [] },
      { id: 'lab/unknown', name: 'Unknown' },
      { id: 'lab/vision-chat', name: 'Vision Chat', input_modalities: ['text', 'image'] },
      { id: 'deepseek/org/dynamic', name: 'Unavailable exact model', input_modalities: [], available: false },
    ])

    expect(choices).toEqual([
      expect.objectContaining({ id: '' }),
      expect.objectContaining({ id: 'lab/image-only', disabled: true, visual: false }),
      expect.objectContaining({ id: 'lab/empty', disabled: true, visual: false }),
      expect.objectContaining({ id: 'lab/unknown', disabled: false, visual: false }),
      expect.objectContaining({ id: 'lab/vision-chat', disabled: false, visual: true }),
      expect.objectContaining({ id: 'deepseek/org/dynamic', disabled: true, visual: false }),
    ])
  })
})

interface Report { namespace: string; key: string; locale: 'zh' | 'en' }

let reports: Report[] = []

beforeEach(() => {
  reports = []
  setMissingKeyReporter(r => { reports.push(r) })
})

afterEach(() => {
  setMissingKeyReporter(null)
  resetMissingKeyWarnings()
})

describe('i18n runtime: locale switching (acceptance §8 line 135)', () => {
  it('zh/en key parity still holds exactly (static gate kept)', () => {
    expect(localeParityReport()).toEqual([])
  })

  it('uses the dsh Scholar wordmark consistently in both locales', () => {
    for (const locale of ['zh', 'en'] as const) {
      setLocale(locale)
      expect(t('shell', 'shell.brand.mark')).toBe('dsh')
      expect(t('shell', 'shell.brand.name')).toBe('Scholar')
      expect(t('shell', 'shell.sidebar.product')).toBe('Scholar')
      expect(t('shell', 'shell.documentTitle', { project: '', tab: 'Chat' })).toBe('dsh Scholar — Chat')
      expect(t('shell', 'shell.chat.welcome')).toContain('dsh Scholar')
      expect(t('shell', 'shell.chat.welcome')).not.toContain('Research OS')
      expect(t('standalone', 'standalone.pageTitle')).toBe('dsh Scholar')
      expect(t('standalone', 'standalone.brand.name')).toBe('Scholar')
    }
  })

  it('setLocale bumps the revision, notifies listeners and persists the locale', () => {
    let notified = 0
    const unsubscribe = subscribeLocale(() => { notified += 1 })
    const rev = getLocaleRevision()
    setLocale('zh')
    expect(getLocale()).toBe('zh')
    expect(getLocaleRevision()).toBeGreaterThan(rev)
    expect(notified).toBe(1)
    setLocale('en')
    expect(getLocale()).toBe('en')
    expect(notified).toBe(2)
    unsubscribe()
    setLocale('zh')
    expect(notified).toBe(2)
  })

  it('tab labels/descriptions re-evaluate after a locale switch', () => {
    const visibility = { budgetPage: true }
    setLocale('zh')
    const zhTabs = chromeTabs(visibility)
    const zhGroups = chromeTabGroups(visibility)
    expect(zhTabs.length).toBeGreaterThan(1)
    expect(zhGroups.length).toBeGreaterThan(1)
    // every tab carries non-empty copy in zh…
    for (const tab of zhTabs) {
      expect(tab.label).not.toBe('')
      expect(tab.description).not.toBe('')
    }
    setLocale('en')
    const enTabs = chromeTabs(visibility)
    const enGroups = chromeTabGroups(visibility)
    // …same keys/order in en (structure is locale-independent)…
    expect(enTabs.map(t => t.key)).toEqual(zhTabs.map(t => t.key))
    expect(enGroups.map(g => g.tabs.map(t => t.key))).toEqual(zhGroups.map(g => g.tabs.map(t => t.key)))
    // …but every label/description differs between the two locales.
    for (const zh of zhTabs) {
      const en = enTabs.find(e => e.key === zh.key)
      expect(en).toBeDefined()
      expect(en!.label).not.toBe(zh.label)
      expect(en!.description).not.toBe(zh.description)
    }
    for (const zh of zhGroups) {
      const en = enGroups.find(e => e.tabs[0]!.key === zh.tabs[0]!.key)
      expect(en).toBeDefined()
      expect(en!.label).not.toBe(zh.label)
    }
    // zh→en→zh round-trip returns identical copy (no drift). (Proper nouns
    // like shell.brand.name="Research" are intentionally identical in both
    // locales, so the round-trip uses real copy keys.)
    setLocale('zh')
    const zhBrand = t('shell', 'shell.tab.chat')
    expect(zhBrand).toBe('对话')
    setLocale('en')
    expect(t('shell', 'shell.tab.chat')).toBe('Chat')
    setLocale('zh')
    expect(getLocale()).toBe('zh')
    expect(t('shell', 'shell.tab.chat')).toBe(zhBrand)
    expect(chromeTabs(visibility).map(x => x.label)).toEqual(zhTabs.map(x => x.label))
  })

  it('model selector choices re-evaluate with the locale', () => {
    const runtimeModels = [
      { id: 'deepseek-official/text', name: 'Text', input_modalities: ['text'] as const },
      { id: 'deepseek-official/vision', name: 'Vision', input_modalities: ['text', 'image'] as const },
    ]
    setLocale('zh')
    const zhModels = chromeModelChoices(runtimeModels)
    setLocale('en')
    const enModels = chromeModelChoices(runtimeModels)
    expect(enModels.map(m => m.id)).toEqual(zhModels.map(m => m.id))
    // Model names are proper nouns (identical in both locales), but the
    // 'auto' seat is real copy and must differ.
    for (const m of enModels) expect(m.label).not.toBe('')
    expect(zhModels.find(m => m.id === '')!.label).toBe('自动（默认）')
    expect(enModels.find(m => m.id === '')!.label).toBe('Auto (default)')
    expect(enModels.find(m => m.id.endsWith('/vision'))!.label).toBe('👁 Vision')
    expect(enModels.find(m => m.id.endsWith('/text'))!.label).toBe('Text')
  })

  it('direct command descriptions re-evaluate from i18n keys', () => {
    setLocale('zh')
    const zhDescriptions = CHAT_COMMANDS.map(([, , key]) => t('shell', key))
    setLocale('en')
    const enDescriptions = CHAT_COMMANDS.map(([, , key]) => t('shell', key))
    expect(zhDescriptions).toHaveLength(CHAT_COMMANDS.length)
    expect(enDescriptions).toHaveLength(CHAT_COMMANDS.length)
    expect(zhDescriptions.every((value, index) => value !== enDescriptions[index])).toBe(true)
    expect(reports).toEqual([])
  })

  it('pipeline steps re-evaluate after a locale switch', () => {
    setLocale('zh')
    const zhPipeline = phasePipeline()
    expect(zhPipeline.length).toBeGreaterThan(1)
    setLocale('en')
    const enPipeline = phasePipeline()
    // same step keys (wire enum order)…
    expect(enPipeline.map(p => p[0])).toEqual(zhPipeline.map(p => p[0]))
    // …but every step label differs between the two locales.
    for (const [key, zhLabel] of zhPipeline) {
      const enLabel = enPipeline.find(p => p[0] === key)![1]
      expect(enLabel).not.toBe(zhLabel)
      expect(enLabel).not.toBe('')
    }
  })

  it('status pill labels re-evaluate; unknown enums stay raw verbatim', () => {
    setLocale('zh')
    const zhDraft = statusLabel('DRAFT')
    const zhSurveyReady = statusLabel('SURVEYING')
    const zhExperiment = statusLabel('EXPERIMENTING')
    const zhPending = statusLabel('pending')
    expect(zhDraft).not.toBe('')
    expect(zhSurveyReady).toBe('调研已就绪')
    expect(zhExperiment).not.toBe('')
    setLocale('en')
    // en mirrors the kernel enum values exactly (as before).
    expect(statusLabel('DRAFT')).toBe('DRAFT')
    expect(statusLabel('SURVEYING')).toBe('SURVEY READY')
    expect(statusLabel('EXPERIMENTING')).toBe('EXPERIMENT')
    expect(statusLabel('pending')).toBe('PENDING')
    // zh actually translates them.
    expect(statusLabel('DRAFT')).not.toBe(zhDraft)
    expect(statusLabel('SURVEYING')).not.toBe(zhSurveyReady)
    expect(statusLabel('EXPERIMENTING')).not.toBe(zhExperiment)
    expect(statusLabel('pending')).not.toBe(zhPending)
    // unknown future enum → raw wire value (§8 line 115).
    setLocale('en')
    expect(statusLabel('SOME_FUTURE_ENUM')).toBe('SOME_FUTURE_ENUM')
    expect(statusLabel(undefined)).toBe('')
  })

  it('Terminal status/meta/exit copy re-evaluates with the locale', () => {
    setLocale('zh')
    expect(t('terminal', 'terminal.status.live')).toBe('实时')
    const zhMeta = t('terminal', 'terminal.meta', {
      seq: '3', lines: '1/10000', bytes: '42',
      dropped: '', truncated: '', exit: '',
    })
    expect(zhMeta).toContain('seq 3')
    expect(zhMeta).toContain('字节')
    setLocale('en')
    expect(t('terminal', 'terminal.status.live')).toBe('live')
    const enMeta = t('terminal', 'terminal.meta', {
      seq: '3', lines: '1/10000', bytes: '42',
      dropped: t('terminal', 'terminal.meta.dropped', { count: '2' }),
      truncated: t('terminal', 'terminal.meta.truncated'),
      exit: t('terminal', 'terminal.meta.exit', { code: '1' }),
    })
    expect(enMeta).toContain('seq 3')
    expect(enMeta).toContain('42 byte(s)')
    expect(enMeta).toContain('2 dropped')
    expect(enMeta).toContain('truncated')
    expect(enMeta).toContain('exit 1')
    const zhExit = ((): string => {
      setLocale('zh')
      const code = t('terminal', 'terminal.exit.code', { code: '1' })
      const truncated = t('terminal', 'terminal.meta.truncated')
      const dropped = t('terminal', 'terminal.meta.dropped', { count: '5' })
      return t('terminal', 'terminal.exitLine', { code, signal: '', truncated, bytes: '123', dropped })
    })()
    expect(zhExit).toContain('退出')
    expect(zhExit).toContain('123 字节')
    expect(zhExit).toContain('已截断')
    expect(zhExit).toContain('丢弃 5 字节')
  })

  it('open overlays are rebuilt on setLocale and stale ones are pruned', () => {
    setLocale('zh')
    let opens = 0
    const live = { isConnected: true }
    const liveId = registerOverlayRebuild(live, () => { opens += 1 })
    // overlay === null is treated as always-live (Node registrations).
    const nullId = registerOverlayRebuild(null, () => { opens += 1 })
    setLocale('en')
    expect(opens).toBe(2)
    // An overlay the user closed (isConnected=false) is skipped + pruned.
    const stale = { isConnected: false }
    registerOverlayRebuild(stale, () => { opens += 1 })
    setLocale('zh')
    expect(opens).toBe(4) // only the two live ones rebuilt again
    unregisterOverlayRebuild(liveId)
    unregisterOverlayRebuild(nullId)
    setLocale('en')
    expect(opens).toBe(4) // unregistered overlays are never rebuilt
    expect(relocalizeOpenOverlays()).toBe(0)
  })
})

describe('i18n runtime: missing-key warnings (acceptance §8 line 139)', () => {
  it('a fully-missing key falls back to the raw key and reports once per call', () => {
    // dev-mode probe: vitest runs with MODE='test' → console.warn enabled.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      setLocale('en')
      const text = t('shell', 'shell.runtime.doesNotExist')
      expect(text).toBe('shell.runtime.doesNotExist')
      expect(reports).toHaveLength(1)
      expect(reports[0]).toEqual({ namespace: 'shell', key: 'shell.runtime.doesNotExist', locale: 'en' })
      // dev console warning fired exactly once for this key, with a dict
      // path hint…
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toContain('shell.runtime.doesNotExist')
      expect(String(warn.mock.calls[0]![0])).toContain('locales/shell.ts')
      // …while the collector sees every miss.
      t('shell', 'shell.runtime.doesNotExist')
      expect(reports).toHaveLength(2)
      expect(warn).toHaveBeenCalledTimes(1) // deduped
      setLocale('zh')
      t('shell', 'shell.runtime.doesNotExist')
      expect(reports).toHaveLength(3)
      expect(reports[2]!.locale).toBe('zh')
      expect(warn).toHaveBeenCalledTimes(1) // dedupe spans locales
    } finally {
      warn.mockRestore()
    }
  })

  it('existing keys never warn, even with params', () => {
    setLocale('en')
    expect(t('shell', 'shell.brand.name')).not.toBe('')
    expect(t('common', 'common.updatedAt')).not.toBe('')
    expect(t('overview', 'overview.progress', { pct: '50' })).toContain('50')
    expect(t('terminal', 'terminal.lines', { shown: '1', max: '100' })).toContain('100')
    expect(reports).toEqual([])
  })

  it('evaluating every chrome model under both locales produces no missing keys', () => {
    setLocale('zh')
    chromeTabGroups(); chromeTabs(); chromeModelChoices(); phasePipeline()
    for (const s of ['DRAFT', 'SCOPED', 'EXPERIMENTING', 'BLOCKED_GATE', 'pending', 'succeeded', 'supported', 'none']) {
      expect(statusLabel(s)).not.toBe('')
    }
    setLocale('en')
    chromeTabGroups(); chromeTabs(); chromeModelChoices(); phasePipeline()
    for (const s of ['DRAFT', 'SCOPED', 'EXPERIMENTING', 'BLOCKED_GATE', 'pending', 'succeeded', 'supported', 'none']) {
      expect(statusLabel(s)).not.toBe('')
    }
    expect(reports).toEqual([])
  })
})

describe('i18n runtime: locale choice (acceptance §8 line 134)', () => {
  it('persisted locale wins, then browser regional locales, then zh', () => {
    expect(pickLocale('zh', ['en-US'])).toBe('zh')
    expect(pickLocale('en', [])).toBe('en')
    expect(pickLocale(null, ['zh-CN', 'en-US'])).toBe('zh')
    expect(pickLocale(null, ['en-GB', 'zh-CN'])).toBe('en')
    expect(pickLocale(null, ['fr-FR'])).toBe('zh') // no zh/en candidate → zh
    expect(pickLocale('', ['en'])).toBe('en')
    expect(pickLocale('null', ['en'])).toBe('en')
  })
})
