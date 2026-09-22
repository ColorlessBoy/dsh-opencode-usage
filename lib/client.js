/**
 * dsh-opencode-usage — browser half.
 *
 * Registers one quiet chip into the composer dock (`conversation.composer.dock`
 * — the row the built-in conversation/token stats pills live in) showing the
 * remaining share of each OpenCode Go quota window. The chip is rendered into
 * the built-in stats row itself so it reads as a third pill on the same line;
 * when that row is absent (a session with no settled step and no billing yet)
 * it falls back to its own centered row in the dock.
 *
 * Visibility follows the CURRENT model selection's provider, read from the
 * durable `modelSelection` projection (the value the /model popup writes), so
 * switching models re-reads within one render. The host half decides whether
 * that provider is actually an OpenCode Zen Go route, by URL.
 *
 * This file is a hand-written module-table bundle: it registers a factory with
 * `window.__ModuleLoader__.load` and pulls only baseline modules through the
 * `require` the factory receives.
 */

window.__ModuleLoader__.load({
  id: 'dsh-opencode-usage',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const { createPortal } = require('react-dom')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Dictionary namespace this package owns. */
    const NS = 'opencodeUsage'
    /** Route the host half serves. */
    const API_PATH = '/api/opencode-usage'
    /** Poll period while the current provider is a Zen Go route. */
    const POLL_MS = 15_000
    /** Distance between the trigger and the detail panel. */
    const PANEL_GAP = 8
    /** Viewport margin the panel placement clamp keeps. */
    const PANEL_MARGIN = 12
    /** Hidden-but-measured panel style for the first placement pass. */
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 }
    /** Quota windows in display order: wire key, full label key, inline label key. */
    const WINDOWS = [
      ['rolling', 'opencodeUsage.rolling', 'opencodeUsage.rollingShort'],
      ['weekly', 'opencodeUsage.weekly', 'opencodeUsage.weeklyShort'],
      ['monthly', 'opencodeUsage.monthly', 'opencodeUsage.monthlyShort'],
    ]

    const zh = {
      'opencodeUsage.title': 'OpenCode Go 额度',
      'opencodeUsage.rolling': '5 小时滚动',
      'opencodeUsage.weekly': '每周',
      'opencodeUsage.monthly': '每月',
      'opencodeUsage.rollingShort': '5h',
      'opencodeUsage.weeklyShort': '周',
      'opencodeUsage.monthlyShort': '月',
      'opencodeUsage.remaining': '剩余 {percent}%',
      'opencodeUsage.remainingLead': '剩余',
      'opencodeUsage.remainingTrail': '',
      'opencodeUsage.tightest': '{window} 剩余 {percent}%',
      'opencodeUsage.resetsIn': '{duration}后重置',
      'opencodeUsage.aria': 'OpenCode Go 额度（剩余）：{parts}',
      'opencodeUsage.error': '额度不可用（{code}）',
      'opencodeUsage.days': '{days} 天 {hours} 小时',
      'opencodeUsage.hours': '{hours} 小时 {minutes} 分',
      'opencodeUsage.minutes': '{minutes} 分',
    }
    const en = {
      'opencodeUsage.title': 'OpenCode Go quota',
      'opencodeUsage.rolling': '5-hour rolling',
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

    // The chip lives inside the built-in stats row, so its skin repeats that
    // row's pill tokens and the shared stat-dialog panel tokens; both are
    // --dsw-* semantic aliases, never literal colors.
    const CSS = `
.dou-dock-anchor { display: none; }
.dou-row {
  display: flex;
  justify-content: center;
  gap: 12px;
  max-width: var(--dsh-chat-content-width, 100%);
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
  padding: 4px calc(var(--dsh-composer-side-clearance, 0px) + 16px) 0px;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
}
.dou-anchor { display: inline-flex; min-width: 0; }
.dou-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  max-width: 100%;
  padding: 1px 8px;
  border: none;
  border-radius: 24px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-variant-numeric: tabular-nums;
  line-height: inherit;
  white-space: nowrap;
}
.dou-pill svg { width: 14px; height: 14px; flex: none; }
button.dou-pill { cursor: pointer; }
button.dou-pill:hover,
button.dou-pill[aria-expanded='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.dou-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* This chip carries three segments in one label, so it draws a 1px rule of its
   own instead of the built-in pills' shared middle-dot glyph: the rule plus its
   gutters is measurably narrower than one borrowed dot, and it stays a rule at
   any font size. */
.dou-sep {
  display: inline-block;
  width: 1px;
  height: 10px;
  margin: 0 3px;
  vertical-align: middle;
  background: var(--dsw-alias-separator-primary);
}
.dou-panel {
  position: fixed;
  z-index: 1100;
  box-sizing: border-box;
  width: max-content;
  min-width: min(260px, calc(100vw - 24px));
  max-width: min(420px, calc(100vw - 24px));
  padding: 16px;
  border: 0;
  border-radius: 12px;
  background: var(--dsw-specific-menu);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  cursor: default;
}
.dou-title {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 8px;
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.dou-titleRule { margin-bottom: 10px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dou-titleValue { font-variant-numeric: tabular-nums; }
.dou-titleLabel { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.dou-titleLabel svg { width: 14px; height: 14px; flex: none; }
.dou-details {
  display: grid;
  grid-template-columns: minmax(76px, auto) minmax(0, 1fr);
  gap: 6px 16px;
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
}
.dou-details dt,
.dou-details dd { min-width: 0; margin: 0; }
.dou-details dd {
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
`

    /** Inject this package's stylesheet once per page. */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="dsh-opencode-usage"]') !== null) return
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin-css', 'dsh-opencode-usage')
      tag.textContent = CSS
      document.head.appendChild(tag)
    }
    ensureStyle()

    /**
     * Format a remaining duration from now, at minute resolution.
     * @param ms - milliseconds until the reset.
     * @param t - the bound translator.
     * @returns the compact duration.
     */
    function formatDuration(ms, t) {
      const totalMinutes = Math.max(0, Math.round(ms / 60_000))
      const days = Math.floor(totalMinutes / 1_440)
      const hours = Math.floor((totalMinutes % 1_440) / 60)
      const minutes = totalMinutes % 60
      if (days > 0) return t('opencodeUsage.days', { days, hours })
      if (hours > 0) return t('opencodeUsage.hours', { hours, minutes })
      return t('opencodeUsage.minutes', { minutes })
    }

    /**
     * Render one percent without a trailing `.0`.
     * @param value - the numeric percent.
     * @returns the display text.
     */
    function percentText(value) {
      const rounded = Math.round(value * 10) / 10
      return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
    }

    /** Last good answer per provider route, so switching back renders instantly. */
    const lastBody = new Map()

    /**
     * Follow the dock session's current provider from the durable model-selection
     * projection (the value the /model popup writes).
     * @param props - the composed dock-entry props.
     * @returns the provider route key, or undefined before a selection exists.
     */
    function useProvider(props) {
      const selection = props.useProjection('modelSelection')
      if (selection === null || selection === undefined) return undefined
      return selection.next?.provider ?? selection.lastUsed?.provider
    }

    /**
     * Poll the host's usage endpoint for one provider route.
     * @param provider - the provider route key.
     * @returns `null` while hidden, else the latest answer for this route.
     */
    function useUsage(provider) {
      const [state, setState] = React.useState(null)
      React.useEffect(() => {
        if (provider === undefined || provider === '') return undefined
        let alive = true
        let timer
        const load = async () => {
          let next
          try {
            const response = await fetch(
              `${API_PATH}?provider=${encodeURIComponent(provider)}`,
              { headers: { accept: 'application/json' } },
            )
            next = response.ok ? await response.json() : { applicable: true, error: `http-${response.status}` }
          } catch {
            next = { applicable: true, error: 'network' }
          }
          if (!alive) return
          setState((previous) => {
            if (next.applicable === false) return null
            if (next.usage !== undefined) {
              lastBody.set(provider, next)
              return { provider, body: next }
            }
            const kept = previous !== null && previous.provider === provider
              ? previous.body
              : lastBody.get(provider)
            return { provider, body: kept, error: next.error ?? 'unknown' }
          })
          if (alive) timer = setTimeout(load, POLL_MS)
        }
        load()
        return () => { alive = false; clearTimeout(timer) }
      }, [provider])
      if (provider === undefined || provider === '') return null
      if (state !== null && state.provider === provider) return state
      const cached = lastBody.get(provider)
      return cached === undefined ? null : { provider, body: cached }
    }

    /**
     * Track the built-in stats row inside this dock's own parent, re-resolving
     * when it mounts or unmounts. The chip joins that row so it reads as a third
     * pill beside the two built-ins instead of on a separate line.
     * @param dockRef - ref of this entry's zero-size anchor in the dock.
     * @returns the stats row element, or null while it is absent.
     */
    function useStatsRow(dockRef) {
      const [row, setRow] = React.useState(null)
      React.useLayoutEffect(() => {
        const parent = dockRef.current === null ? null : dockRef.current.parentElement
        if (parent === null) return undefined
        const find = () => parent.querySelector(':scope > [data-composer-stats]')
        setRow(find())
        const observer = new MutationObserver(() => { setRow(find()) })
        observer.observe(parent, { childList: true })
        return () => { observer.disconnect() }
      }, [dockRef])
      return row
    }

    /**
     * Build the trigger pill for one settled answer. Every figure is a remaining
     * share, and the locale supplies the word that says so — as a lead in
     * Chinese and as a trail in English — so no reading here can be taken for a
     * used share.
     * @param rows - the usable windows.
     * @param t - the bound translator.
     * @returns the inline label node and the full accessible name.
     */
    function triggerContent(rows, t) {
      const lead = t('opencodeUsage.remainingLead')
      const trail = t('opencodeUsage.remainingTrail')
      const children = []
      if (lead !== '') children.push(`${lead} `)
      rows.forEach((row, index) => {
        if (index > 0) {
          children.push(h('span', { key: `sep-${row.key}`, className: 'dou-sep', 'aria-hidden': true }))
        }
        children.push(`${t(row.short)} ${percentText(row.window.remainingPercent)}%`)
      })
      if (trail !== '') children.push(` ${trail}`)
      const aria = t('opencodeUsage.aria', {
        parts: rows.map(row => `${t(row.label)} ${percentText(row.window.remainingPercent)}%`).join('，'),
      })
      return { label: h('span', { className: 'dou-label' }, children), aria }
    }

    /**
     * The detail panel: one row per window with its remaining share and reset.
     * @param rows - the usable windows.
     * @param panelRef - ref the placement clamp measures.
     * @param pos - clamped placement, or null before the first measurement.
     * @param t - the bound translator.
     * @returns the portal panel element.
     */
    function detailPanel(rows, panelRef, pos, t) {
      const bottleneck = rows.reduce(
        (lowest, row) => (row.window.remainingPercent < lowest.window.remainingPercent ? row : lowest),
        rows[0],
      )
      return h('div', {
        ref: panelRef,
        className: 'dou-panel',
        role: 'dialog',
        'aria-label': t('opencodeUsage.title'),
        style: pos ?? MEASURE_STYLE,
      },
      h('div', { className: 'dou-title' },
        h('span', { className: 'dou-titleLabel' },
          h(primitives.IconAlarmClockOutline16),
          t('opencodeUsage.title')),
        h('span', { className: 'dou-titleValue' },
          t('opencodeUsage.tightest', {
            window: t(bottleneck.label),
            percent: percentText(bottleneck.window.remainingPercent),
          }))),
      h('div', { className: 'dou-titleRule', 'aria-hidden': true }),
      h('dl', { className: 'dou-details' }, rows.flatMap((row) => {
        const resetAt = row.window.resetsAt === undefined ? undefined : Date.parse(row.window.resetsAt)
        const reset = resetAt === undefined || Number.isNaN(resetAt)
          ? undefined
          : t('opencodeUsage.resetsIn', { duration: formatDuration(resetAt - Date.now(), t) })
        const value = t('opencodeUsage.remaining', { percent: percentText(row.window.remainingPercent) })
        return [
          h('dt', { key: `dt-${row.key}` }, t(row.label)),
          h('dd', { key: `dd-${row.key}` }, reset === undefined ? value : `${value} · ${reset}`),
        ]
      })))
    }

    /**
     * The dock entry: the quota chip plus its detail panel.
     * @param props - the composed dock-entry props (runtime shares + locale seat).
     * @returns the chip (portaled into the built-in stats row when present), or null.
     */
    function QuotaChip(props) {
      const t = props.t
      const provider = useProvider(props)
      const state = useUsage(provider)
      const [open, setOpen] = React.useState(false)
      const rootRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const dockRef = React.useRef(null)
      const statsRow = useStatsRow(dockRef)
      const pos = primitives.useAnchoredPosition({
        open, anchorRef: rootRef, panelRef, side: 'top', gap: PANEL_GAP, margin: PANEL_MARGIN,
      })
      primitives.useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
      React.useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('keydown', onKeyDown)
        return () => { document.removeEventListener('keydown', onKeyDown) }
      }, [open])

      const usage = state === null ? undefined : state.body?.usage
      const rows = usage === undefined
        ? []
        : WINDOWS
          .filter(([key]) => typeof usage[key]?.remainingPercent === 'number')
          .map(([key, label, short]) => ({ key, label, short, window: usage[key] }))

      let chip = null
      if (state !== null && rows.length === 0) {
        chip = h('span', { className: 'dou-anchor' },
          h('span', { className: 'dou-pill' },
            h(primitives.IconAlarmClockOutline16),
            h('span', { className: 'dou-label' }, t('opencodeUsage.error', { code: state.error ?? 'unknown' }))))
      } else if (rows.length > 0) {
        const { label, aria } = triggerContent(rows, t)
        chip = h('span', { ref: rootRef, className: 'dou-anchor' },
          h('button', {
            type: 'button',
            className: 'dou-pill',
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-label': aria,
            onClick: () => { setOpen(!open) },
          },
          h(primitives.IconAlarmClockOutline16),
          label),
          open ? createPortal(detailPanel(rows, panelRef, pos, t), document.body) : null)
      }

      return h(React.Fragment, null,
        h('span', { ref: dockRef, className: 'dou-dock-anchor' }),
        chip === null
          ? null
          : statsRow === null
            ? h('div', { className: 'dou-row' }, chip)
            : createPortal(chip, statsRow))
    }

    exports.inject = ['slots', 'locale']
    exports.QuotaChip = QuotaChip
    exports.formatDuration = formatDuration
    exports.percentText = percentText

    /**
     * Register the quota chip into the composer dock beside the built-in stats.
     * @param ctx - the client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'opencode-usage: dictionaries')
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'opencode-usage',
        order: 20,
        locale: NS,
      }, QuotaChip))
    }
    exports.apply = apply

    return module.exports
  },
})
