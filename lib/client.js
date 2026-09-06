// dsh-plugin-fallback-continue — browser half.
//
// Served at runtime by @deepseek-ai/dsh-client-modules as
// `/plugins/dsh-plugin-fallback-continue/client.js` and mounted by the web
// kernel on every page load.
//
// UI: a bottom-right floating pill showing the live countdown for the CURRENT
// session only (pause/resume on click, cancel on ✕), plus a "失敗自動繼續"
// settings page with the enable toggle, fields, and a per-session wait list.
//
// Client -> host calls ride the generic Connection RPC channel
// (`/api/fallbackContinue/*`), dispatched by the Typert gateway to the host
// half's `fallbackContinue` Remote service.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-fallback-continue',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    // ---------------------------------------------------------------- locale
    const zh = {
      title: '失敗自動繼續',
      enable: '啟用',
      continueText: '自動送出的文字',
      intervals: '重試間隔（分鐘，逗號分隔）',
      save: '儲存',
      capEnable: '超過上限自動停止',
      capHours: '上限時數（0＝無上限）',
      loading: '載入中…',
      noSessions: '目前沒有等待中的會話。',
      paused: '已暫停',
      awaiting: '已送出，等待結果',
      resume: '繼續',
      retryNow: '立即重試',
      cancel: '取消',
      version: '版本',
      pillAfter: '後自動繼續',
      pillSent: '已送出',
      pillWait: '，等待結果',
      readFailed: '讀取失敗',
      saveFailed: '儲存失敗',
    }
    const en = {
      title: 'Fail auto-continue',
      enable: 'Enable',
      continueText: 'Text to send',
      intervals: 'Retry intervals (min, comma-separated)',
      save: 'Save',
      capEnable: 'Auto-stop over limit',
      capHours: 'Hour limit (0 = off)',
      loading: 'Loading…',
      noSessions: 'No sessions waiting.',
      paused: 'Paused',
      awaiting: 'Sent, awaiting result',
      resume: 'Resume',
      retryNow: 'Retry now',
      cancel: 'Cancel',
      version: 'Version',
      pillAfter: 'auto-continue in',
      pillSent: 'Sent',
      pillWait: ', awaiting result',
      readFailed: 'Read failed',
      saveFailed: 'Save failed',
    }
    const DICTS = { zh, en, 'zh-CN': zh, 'zh-TW': zh }
    let t = (key) => (key in zh ? zh[key] : key)

    // ---------------------------------------------------------------- helpers
    const fmtClock = (ms) => {
      if (ms == null || ms < 0) return '0:00'
      const totalSec = Math.max(0, Math.floor(ms / 1000))
      const h = Math.floor(totalSec / 3600)
      const m = Math.floor((totalSec % 3600) / 60)
      const s = totalSec % 60
      const p = (n) => (n < 10 ? '0' + n : String(n))
      if (h > 0) return h + ':' + p(m) + ':' + p(s)
      return m + ':' + p(s)
    }
    const shortId = (id) => {
      const s = String(id || '')
      return s.length > 14 ? s.slice(0, 14) + '…' : s
    }
    const fromConfig = (c) => {
      c = c || {}
      return {
        enabled: !!c.enabled,
        continueText: typeof c.continueText === 'string' ? c.continueText : '繼續',
        intervalsText: (c.retryIntervalsMinutes || []).join(','),
        capEnabled: typeof c.capEnabled === 'boolean' ? c.capEnabled : true,
        capHours: typeof c.capHours === 'number' ? c.capHours : 24,
      }
    }

    // -------------------------------------------------------------- host RPC
    let rpc = () => Promise.resolve({ ok: false, error: { message: 'rpc-not-wired' } })
    const call = (method, args) => rpc(method, args || {})
    const bindRpc = (ctx) => {
      const conn = ctx.get('connection')
      rpc = async (method, args) => {
        const result = await conn.rpc.call('/api', 'fallbackContinue/' + method, { args: args || {} })
        if (!result || result.ok !== true) {
          const message = result && result.error && result.error.message ? result.error.message : 'request-failed'
          throw new Error(message)
        }
        return result.value
      }
    }

    // ------------------------------------------------- shared polling store
    // One store + one 1s interval, shared by the pill and the settings page.
    let state = null
    const listeners = new Set()
    let pollTimer = null
    let pollCount = 0
    const notify = () => { for (const fn of Array.from(listeners)) fn() }
    const refresh = () => {
      call('getState').then((s) => { state = s; notify() }).catch(() => {})
    }
    const subscribePoll = (fn) => {
      listeners.add(fn)
      pollCount += 1
      if (pollTimer == null) {
        refresh()
        pollTimer = setInterval(refresh, 1000)
      }
      return () => {
        listeners.delete(fn)
        pollCount -= 1
        if (pollCount <= 0 && pollTimer != null) { clearInterval(pollTimer); pollTimer = null }
      }
    }
    const useFallbackState = () => {
      const [snap, setSnap] = React.useState(state)
      React.useEffect(() => subscribePoll(() => setSnap(state)), [])
      return snap
    }

    // ------------------------------------------------------------ floating pill
    const Pill = (props) => {
      const useSessions = props.useSessions
      const h = React.createElement
      const state = useFallbackState()

      let currentId = null
      if (useSessions && typeof useSessions === 'function') {
        currentId = useSessions((s) => (s && s.current ? String(s.current) : null))
      }

      if (!state || !currentId) return null
      const entry = state.sessions && state.sessions.find((e) => e.sessionId === currentId)
      if (!entry) return null

      const cancelPill = () => call('cancel', { sessionId: currentId }).catch(() => {})

      if (entry.phase === 'awaiting') {
        return h('div', { className: 'fbc-pill fbc-pill-muted' },
          h('span', { className: 'fbc-pill-text' }, t('pillSent') + '「' + (entry.text || '繼續') + '」' + t('pillWait')),
          h('span', { className: 'fbc-pill-x', title: t('cancel'), onClick: cancelPill }, '✕'),
        )
      }

      const text = entry.text || '繼續'
      const label = entry.paused
        ? '⏸ ' + fmtClock(entry.remainingMs) + ' ' + t('paused')
        : '⏳ ' + fmtClock(entry.remainingMs) + ' ' + t('pillAfter') + '「' + text + '」(#' + (entry.failures + 1) + ')'

      const toggle = () => {
        if (entry.paused) call('resume', { sessionId: currentId }).catch(() => {})
        else call('pause', { sessionId: currentId }).catch(() => {})
      }

      return h('div', { className: 'fbc-pill' },
        h('span', { className: 'fbc-pill-text', title: 'pause/resume', onClick: toggle }, label),
        h('span', { className: 'fbc-pill-x', title: t('cancel'), onClick: cancelPill }, '✕'),
      )
    }

    // ------------------------------------------------------------ settings page
    const SettingsPage = (props) => {
      const h = React.createElement
      const state = useFallbackState()
      const [draft, setDraft] = React.useState(null)
      const [msg, setMsg] = React.useState(null)

      React.useEffect(() => {
        if (state && draft === null) setDraft(fromConfig(state.config))
      }, [state])

      if (!state) return h('div', { className: 'fbc-settings' }, h('p', null, t('loading')))
      if (!draft) return h('div', { className: 'fbc-settings' }, h('p', null, t('loading')))

      const save = async (patch) => {
        setMsg(null)
        try {
          // The host method is `updateConfig(patch)`; the gateway binds args
          // fields to parameter names by exact match, so nest under `patch`.
          const r = await call('updateConfig', { patch })
          if (r && r.ok) {
            setDraft(fromConfig(r.config))
          } else {
            setMsg(t('saveFailed'))
          }
        } catch (e) {
          setMsg(t('saveFailed') + '：' + (e && e.message ? e.message : String(e)))
        }
      }

      const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

      return h('div', { className: 'fbc-settings' },
        h('h3', null, t('title')),
        h('label', { className: 'fbc-row fbc-toggle' },
          h('input', { type: 'checkbox', checked: !!draft.enabled, onChange: (ev) => save({ enabled: ev.target.checked }) }),
          h('span', null, t('enable')),
        ),
        h('div', { className: 'fbc-field' },
          h('label', { className: 'fbc-label' }, t('continueText')),
          h('input', { className: 'fbc-input', type: 'text', value: draft.continueText, onChange: (ev) => setDraft({ ...draft, continueText: ev.target.value }) }),
          h('button', { className: 'fbc-btn', onClick: () => save({ continueText: draft.continueText }) }, t('save')),
        ),
        h('div', { className: 'fbc-field' },
          h('label', { className: 'fbc-label' }, t('intervals')),
          h('input', { className: 'fbc-input', type: 'text', value: draft.intervalsText, onChange: (ev) => setDraft({ ...draft, intervalsText: ev.target.value }) }),
          h('button', { className: 'fbc-btn', onClick: () => save({ retryIntervals: draft.intervalsText }) }, t('save')),
        ),
        h('label', { className: 'fbc-row fbc-toggle' },
          h('input', { type: 'checkbox', checked: !!draft.capEnabled, onChange: (ev) => save({ capEnabled: ev.target.checked }) }),
          h('span', null, t('capEnable')),
        ),
        h('div', { className: 'fbc-field' },
          h('label', { className: 'fbc-label' }, t('capHours')),
          h('input', { className: 'fbc-input', type: 'number', min: 0, value: String(draft.capHours), onChange: (ev) => setDraft({ ...draft, capHours: ev.target.value }) }),
          h('button', { className: 'fbc-btn', onClick: () => save({ capHours: num(draft.capHours) }) }, t('save')),
        ),
        waitList(state, h),
        msg ? h('p', { className: 'fbc-msg' }, msg) : null,
        h('div', { className: 'fbc-footer' }, t('version') + ' ' + state.version),
      )
    }

    function waitList(state, h) {
      const rows = (state.sessions || [])
      if (rows.length === 0) {
        return h('p', { className: 'fbc-muted' }, t('noSessions'))
      }
      return h('div', { className: 'fbc-list' },
        rows.map((e) => {
          const phaseText = e.phase === 'awaiting'
            ? t('awaiting')
            : (e.paused ? t('paused') : fmtClock(e.remainingMs))
          return h('div', { key: e.sessionId, className: 'fbc-list-row' },
            h('div', { className: 'fbc-list-main' },
              h('div', { className: 'fbc-list-title' }, shortId(e.sessionId)),
              h('div', { className: 'fbc-list-sub' },
                '#' + (e.failures + 1) + ' · ' + phaseText + ' · ' + (e.reason || 'error')),
            ),
            h('div', { className: 'fbc-list-actions' },
              e.phase === 'counting'
                ? h('button', { className: 'fbc-btn', onClick: () => (e.paused ? call('resume', { sessionId: e.sessionId }) : call('pause', { sessionId: e.sessionId })) }, e.paused ? t('resume') : t('paused'))
                : null,
              e.phase === 'counting'
                ? h('button', { className: 'fbc-btn', onClick: () => call('retryNow', { sessionId: e.sessionId }) }, t('retryNow'))
                : null,
              h('button', { className: 'fbc-btn fbc-btn-danger', onClick: () => call('cancel', { sessionId: e.sessionId }) }, t('cancel')),
            ),
          )
        }),
      )
    }

    // ---------------------------------------------------------------- CSS
    const CSS = [
      '.fbc-pill { position: fixed; right: 16px; bottom: 16px; z-index: 10000; display: flex; align-items: center; gap: 8px; background: rgba(20,20,28,0.92); color: var(--dsw-alias-label-primary, #eee); border: 1px solid var(--dsw-alias-border-inverted, rgba(255,255,255,0.14)); border-radius: 999px; padding: 7px 14px; font-size: 12px; line-height: 1; box-shadow: var(--dsw-shadow-lv3, 0 4px 16px rgba(0,0,0,0.4)); pointer-events: auto; font-family: system-ui, -apple-system, sans-serif; }',
      '.fbc-pill-muted { opacity: 0.8; }',
      '.fbc-pill-text { cursor: pointer; user-select: none; }',
      '.fbc-pill-muted .fbc-pill-text { cursor: default; }',
      '.fbc-pill-x { cursor: pointer; opacity: 0.7; padding-left: 2px; }',
      '.fbc-pill-x:hover { opacity: 1; }',
      '.fbc-settings { display: flex; flex-direction: column; gap: 12px; padding: 4px 0; font-size: 13px; color: var(--dsw-alias-label-primary, inherit); }',
      '.fbc-settings h3 { margin: 0; font-size: 15px; }',
      '.fbc-row { display: flex; align-items: center; gap: 8px; }',
      '.fbc-toggle input { cursor: pointer; }',
      '.fbc-field { display: flex; flex-direction: column; gap: 4px; }',
      '.fbc-label { font-size: 11px; opacity: 0.7; }',
      '.fbc-input { padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.12)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.04)); color: inherit; font-size: 13px; }',
      '.fbc-btn { padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14)); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; font-size: 12px; }',
      '.fbc-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.12)); }',
      '.fbc-btn-danger:hover { border-color: var(--dsw-alias-state-error-primary, rgba(255,90,90,0.6)); color: var(--dsw-alias-state-error-primary, #ff9a9a); }',
      '.fbc-list { display: flex; flex-direction: column; gap: 8px; }',
      '.fbc-list-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.10)); border-radius: 8px; }',
      '.fbc-list-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }',
      '.fbc-list-title { font-weight: 600; }',
      '.fbc-list-sub { font-size: 11px; opacity: 0.7; }',
      '.fbc-list-actions { display: flex; gap: 6px; flex-shrink: 0; }',
      '.fbc-muted { opacity: 0.6; }',
      '.fbc-msg { color: var(--dsw-alias-state-error-primary, #ff8a8a); font-size: 12px; }',
      '.fbc-footer { margin-top: 8px; font-size: 11px; opacity: 0.5; }',
    ].join('\n')

    const injectCss = (css) => {
      const tag = document.createElement('style')
      tag.setAttribute('data-dsh-fbc', 'fallback-continue')
      tag.textContent = css
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    // ---------------------------------------------------------------- apply
    const inject = ['slots', 'connection']

    function apply(ctx) {
      bindRpc(ctx)

      const locale = ctx.get('locale')
      if (locale !== undefined) {
        try {
          ctx.effect(() => locale.register('fallback-continue', 'zh', zh))
          ctx.effect(() => locale.register('fallback-continue', 'en', en))
          t = locale.bind('fallback-continue')
        } catch (error) {
          console.error('fallback-continue locale registration failed:', String(error))
        }
      }

      ctx.effect(() => injectCss(CSS), 'fallback-continue: styles')

      const slots = ctx.get('slots')
      if (slots === undefined) return

      ctx.effect(() => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'fallback-continue-pill', order: 500 },
        Pill,
      )), 'fallback-continue: pill')

      ctx.effect(() => slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'fallback-continue', order: 30, label: () => t('title') },
        SettingsPage,
      )), 'fallback-continue: settings')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})