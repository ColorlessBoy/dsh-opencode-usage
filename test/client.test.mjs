/**
 * Browser-half behaviour check: the bundle registers a factory, mounts the
 * dock entry, reads the provider from the model-selection projection, renders
 * the three remaining shares as its own pill beside the built-in stats row,
 * and opens the detail panel.
 *
 * React, react-dom, and jsdom are resolved from the DSH checkout so this stays
 * dependency-free.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const CHECKOUT = process.env.DSH_CHECKOUT ?? '/Users/penglingwei/Documents/code-agent/deepseek-harness'
const requireFromChat = createRequire(`${CHECKOUT}/packages/client/ui-chat/package.json`)
const requireFromRoot = createRequire(`${CHECKOUT}/package.json`)
const React = requireFromChat('react')
const ReactDOM = requireFromChat('react-dom/client')
const act = React.act ?? requireFromChat('react-dom/test-utils').act
const { JSDOM } = requireFromRoot('jsdom')

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="dock"></div></body></html>', {
  url: 'http://127.0.0.1:3080/',
})
for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** Minimal primitives face: the real hooks are exercised by their own package. */
const primitives = {
  useAnchoredPosition: () => null,
  useDismissOnOutsidePointer: () => {},
}

const DICT = {
  'opencodeUsage.title': 'OpenCode Go quota',
  'opencodeUsage.rolling': 'Rolling',
  'opencodeUsage.weekly': 'Weekly',
  'opencodeUsage.monthly': 'Monthly',
  'opencodeUsage.rollingShort': '5h',
  'opencodeUsage.weeklyShort': 'wk',
  'opencodeUsage.monthlyShort': 'mo',
  'opencodeUsage.remaining': '{percent}% left',
  'opencodeUsage.remainingLead': '',
  'opencodeUsage.remainingTrail': 'left',
  'opencodeUsage.tightest': '{window} {percent}% left',
  'opencodeUsage.resetsIn': 'resets in {duration}',
  'opencodeUsage.aria': 'OpenCode Go quota remaining: {parts}',
  'opencodeUsage.error': 'Quota unavailable ({code})',
  'opencodeUsage.days': '{days}d {hours}h',
  'opencodeUsage.hours': '{hours}h {minutes}m',
  'opencodeUsage.minutes': '{minutes}m',
}
const t = (key, params) => String(DICT[key] ?? key)
  .replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))

let registration
dom.window.__ModuleLoader__ = { load: (value) => { registration = value } }
dom.window.eval(readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8'))
assert.equal(registration.id, 'dsh-opencode-usage')

const exports = registration.factory((spec) => {
  if (spec === 'react') return React
  if (spec === 'react-dom') return requireFromChat('react-dom')
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require: ${spec}`)
})
assert.deepEqual(exports.inject, ['slots', 'locale'])
assert.equal(typeof exports.apply, 'function')
assert.equal(exports.percentText(88.5), '88.5')
assert.equal(exports.percentText(45), '45')
assert.equal(exports.formatDuration(3 * 3600_000 + 12 * 60_000, t), '3h 12m')
assert.equal(exports.formatDuration(6 * 86_400_000 + 21 * 3600_000, t), '6d 21h')
assert.equal(exports.formatDuration(45 * 60_000, t), '45m')
assert.ok(dom.window.document.querySelector('style[data-plugin-css="dsh-opencode-usage"]') !== null)

// apply() registers the dictionaries and the dock entry.
let registered
let registeredDicts
const ctx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, dicts) => {
      assert.equal(ns, 'opencodeUsage')
      assert.ok(dicts.zh && dicts.en)
      registeredDicts = dicts
    },
  },
  slots: {
    inject: (name, contribute) => { assert.equal(name, 'conversation.composer.dock'); registered = contribute() },
    register: (options, component) => {
      assert.equal(options.name, 'conversation.composer.dock')
      assert.equal(options.locale, 'opencodeUsage')
      assert.equal(typeof component, 'function')
      return () => {}
    },
  },
}
exports.apply(ctx)
assert.ok(registered !== undefined)

const inHours = (hours) => new Date(Date.now() + hours * 3600_000).toISOString()
const USAGE = {
  applicable: true,
  usage: {
    rolling: { status: 'ok', remainingPercent: 94, resetsAt: inHours(3) },
    weekly: { status: 'ok', remainingPercent: 88.5, resetsAt: inHours(6 * 24) },
    monthly: { status: 'ok', remainingPercent: 45, resetsAt: inHours(26 * 24) },
  },
}
const fetched = []
let selection = { next: { provider: 'opencode-go-3' }, lastUsed: null }
let answer = USAGE
globalThis.fetch = async (url) => {
  fetched.push(String(url))
  return { ok: true, json: async () => answer }
}

const props = { t, useProjection: () => selection }
const container = dom.window.document.createElement('div')
dom.window.document.getElementById('dock').appendChild(container)

/**
 * Render the chip beside a stand-in built-in stats row, exactly as the dock
 * renders two sibling entries.
 * @param withStatsRow - whether the built-in stats row mounts beside the chip.
 * @returns the harness element.
 */
function Harness({ withStatsRow }) {
  return React.createElement(React.Fragment, null,
    withStatsRow
      ? React.createElement('div', { 'data-composer-stats': true },
        React.createElement('span', { className: 'builtin' }, '11 turns 44 steps'))
      : null,
    React.createElement(exports.QuotaChip, props))
}

const root = ReactDOM.createRoot(container)
const settle = async () => {
  await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
}

await act(async () => { root.render(React.createElement(Harness, { withStatsRow: true })) })
await settle()

// The chip is its own dock item, a sibling of the built-in stats row.
const statsRow = container.querySelector(':scope > [data-composer-stats]')
const chip = container.querySelector(':scope > .dou-anchor')
assert.ok(chip !== null, 'chip is its own dock item')
assert.equal(statsRow.querySelector('.dou-anchor'), null, 'chip is not nested in the built-in stats row')
assert.equal(statsRow.querySelector('.builtin').textContent, '11 turns 44 steps')
// The separators are this plugin's own empty 1px rules, not the built-in dot glyph.
const separators = chip.querySelectorAll('.dou-sep')
assert.equal(separators.length, 2)
assert.deepEqual([...separators].map(node => node.textContent), ['', ''])
assert.equal(chip.querySelector('.dou-label').textContent, '5h 94%wk 88.5%mo 45% left')
const button = chip.querySelector('button.dou-pill')
assert.equal(button.getAttribute('aria-haspopup'), 'dialog')
assert.equal(button.getAttribute('aria-label'), 'OpenCode Go quota remaining: Rolling 94%，Weekly 88.5%，Monthly 45%')
assert.deepEqual(fetched, ['/api/opencode-usage?provider=opencode-go-3'])

// Clicking opens the detail panel with per-window rows and reset countdowns.
await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
const panel = dom.window.document.body.querySelector('.dou-panel')
assert.ok(panel !== null, 'detail panel is portaled to the body')
assert.equal(panel.getAttribute('aria-label'), 'OpenCode Go quota')
assert.equal(panel.querySelector('.dou-titleValue').textContent, 'Monthly 45% left')
assert.deepEqual([...panel.querySelectorAll('dt, dd')].map(node => node.textContent), [
  'Rolling', '94% left · resets in 3h 0m',
  'Weekly', '88.5% left · resets in 6d 0h',
  'Monthly', '45% left · resets in 26d 0h',
])
await act(async () => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })) })
assert.equal(dom.window.document.body.querySelector('.dou-panel'), null, 'Escape closes the panel')

// A provider that is not a Zen Go route hides the chip entirely.
fetched.length = 0
answer = { applicable: false }
selection = { next: { provider: 'deepseek-official' }, lastUsed: null }
await act(async () => { root.render(React.createElement(Harness, { withStatsRow: true })) })
await settle()
assert.equal(container.querySelector('.dou-anchor'), null)
assert.deepEqual(fetched, ['/api/opencode-usage?provider=deepseek-official'])

// A failing route shows the error copy instead of numbers.
fetched.length = 0
answer = { applicable: true, error: 'http-429' }
selection = { next: { provider: 'opencode-go-http' }, lastUsed: null }
await act(async () => { root.render(React.createElement(Harness, { withStatsRow: true })) })
await settle()
const errorChip = container.querySelector('.dou-anchor')
assert.ok(errorChip !== null)
assert.equal(errorChip.querySelector('.dou-label').textContent, 'Quota unavailable (http-429)')
assert.equal(errorChip.querySelector('button'), null, 'the error reading is not a dialog trigger')

// The chip renders the same way when no settled step mounted a stats row.
answer = USAGE
selection = { next: { provider: 'opencode-go-3' }, lastUsed: null }
await act(async () => { root.render(React.createElement(Harness, { withStatsRow: false })) })
await settle()
assert.ok(container.querySelector(':scope > .dou-anchor .dou-pill') !== null)
assert.equal(container.querySelector('[data-composer-stats]'), null)

// The last good reading survives a transient failure.
answer = { applicable: true, error: 'network' }
await act(async () => { root.render(React.createElement(Harness, { withStatsRow: false })) })
await settle()
assert.equal(container.querySelector('.dou-anchor .dou-label').textContent, '5h 94%wk 88.5%mo 45% left')

// The shipped Chinese copy, which is what the zh locale preference renders.
answer = USAGE
selection = { next: { provider: 'opencode-go-3' }, lastUsed: null }
const zhT = (key, params) => String(registeredDicts.zh[key] ?? key)
  .replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
const zhContainer = dom.window.document.createElement('div')
dom.window.document.getElementById('dock').appendChild(zhContainer)
const zhRoot = ReactDOM.createRoot(zhContainer)
await act(async () => {
  zhRoot.render(React.createElement(React.Fragment, null,
    React.createElement('div', { 'data-composer-stats': true }),
    React.createElement(exports.QuotaChip, { t: zhT, useProjection: () => selection })))
})
await settle()
assert.equal(zhContainer.querySelector(':scope > .dou-anchor .dou-label').textContent, '剩余 5h 94%周 88.5%月 45%')
assert.equal(
  zhContainer.querySelector(':scope > .dou-anchor button').getAttribute('aria-label'),
  'OpenCode Go 额度（剩余）：5 小时滚动 94%，每周 88.5%，每月 45%',
)
await act(async () => { zhContainer.querySelector(':scope > .dou-anchor button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
const zhPanel = dom.window.document.body.querySelector('.dou-panel')
assert.equal(zhPanel.querySelector('.dou-titleValue').textContent, '每月 剩余 45%')
assert.deepEqual([...zhPanel.querySelectorAll('dt, dd')].map(node => node.textContent), [
  '5 小时滚动', '剩余 94% · 3 小时 0 分后重置',
  '每周', '剩余 88.5% · 6 天 0 小时后重置',
  '每月', '剩余 45% · 26 天 0 小时后重置',
])
await act(async () => { zhRoot.unmount() })

await act(async () => { root.unmount() })
dom.window.close()
console.log('client.test.mjs: all assertions passed')
