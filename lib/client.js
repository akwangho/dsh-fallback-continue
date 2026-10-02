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
      cooldown: '429 限流冷卻間隔（分鐘）',
      cooling: '429 冷卻中',
      loading: '載入中…',
      noSessions: '目前沒有等待中的會話。',
      paused: '已暫停',
      pause: '暫停',
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
      badgeCounting: '正等待自動送出「繼續」',
      badgeAwaiting: '已送出「繼續」，等待結果',
      diagTitle: '⚠ 外掛部分功能無法使用（相容性或安裝問題）',
      settingsUnavailable: '設定表單尚未就緒（仍在載入，或 Host 尚未提供此外掛的設定）。',
      settingsReadonly: '設定目前唯讀：Host 未開放寫入，或設定服務未掛載。',
      saveRejected: 'Host 拒絕了這次變更（可能已被其他分頁修改，請重試）。',
      intervalsInvalid: '重試間隔格式錯誤：請填逗號分隔的正數，例如 5,10,15,30。',
      heldSuffix: '（已保留',
      heldSuffixEnd: ' 則排隊訊息）',
    }
    const en = {
      title: 'Fail auto-continue',
      enable: 'Enable',
      continueText: 'Text to send',
      intervals: 'Retry intervals (min, comma-separated)',
      save: 'Save',
      capEnable: 'Auto-stop over limit',
      capHours: 'Hour limit (0 = off)',
      cooldown: '429 cooldown interval (min)',
      cooling: '429 cooling',
      loading: 'Loading…',
      noSessions: 'No sessions waiting.',
      paused: 'Paused',
      pause: 'Pause',
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
      badgeCounting: 'Waiting to auto-send “Continue”',
      badgeAwaiting: 'Sent “Continue”, awaiting result',
      diagTitle: '⚠ Part of this plugin is unavailable (compatibility or install problem)',
      settingsUnavailable: 'The settings form is not ready (still loading, or the Host has not exposed this plugin\'s settings yet).',
      settingsReadonly: 'Settings are read-only: the Host does not accept writes, or the settings service is not mounted.',
      saveRejected: 'The Host rejected this change (it may have been changed elsewhere; please retry).',
      intervalsInvalid: 'Invalid retry intervals: enter comma-separated positive numbers, e.g. 5,10,15,30.',
      heldSuffix: ' (holding ',
      heldSuffixEnd: ' queued message(s))',
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
        cooldownMinutes: typeof c.cooldownMinutes === 'number' && c.cooldownMinutes > 0 ? c.cooldownMinutes : 720,
      }
    }

    // ------------------------------------------------- configuration (v1.11.0)
    // Configuration is ordinary DSH plugin Config now, declared volatile by the
    // host half. The browser half does not own it and does not ship a parallel
    // copy: it reads and writes the Host's own form for this entry's
    // namespace, which persists into the profile's `cordis.patch.yml`.
    //
    // `configForms.get(ns)` is a live view: `getSnapshot()` returns a stable
    // object until something changes, and `subscribe` fires on each new one.
    // `set(field, value)` is one queued, revision-fenced Host write.
    //
    // `SETTINGS_NS` must equal the host plugin's profile entry id in
    // `cordis.patch.yml`; a mismatch surfaces as a `unavailable` snapshot and is
    // reported below rather than silently doing nothing.
    const SETTINGS_NS = 'fallback-continue'
    let configForm = null
    let configSnapshot = { status: 'loading', value: undefined, writable: false, mode: 'host' }

    const bindConfigForm = (ctx) => {
      const forms = ctx.get('configForms')
      if (!forms || typeof forms.get !== 'function') {
        throw new Error('the "configForms" service is unavailable, so settings cannot be read or saved')
      }
      configForm = forms.get(SETTINGS_NS)
      if (!configForm || typeof configForm.subscribe !== 'function') {
        throw new Error('the settings service exposes no form for namespace "' + SETTINGS_NS + '"')
      }
      configSnapshot = configForm.getSnapshot()
      configForm.subscribe(() => {
        configSnapshot = configForm.getSnapshot()
        notify()
      })
    }

    // One queued Host write. Returns whether the Host accepted it; the live
    // snapshot (not this promise) is what the page renders.
    const setConfigField = async (field, value) => {
      if (!configForm) throw new Error('settings are not wired')
      return configForm.set(field, value)
    }

    // "5,10,15" -> [5, 10, 15]. The schema field is a number array, so the
    // comma-separated text box is parsed here and a fully invalid entry is
    // rejected before it can overwrite a good schedule with an empty one.
    const parseIntervals = (text) => {
      const arr = String(text)
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
      return arr.length > 0 ? arr : null
    }

    // -------------------------------------------------------------- host RPC
    // Session state only (getState / pause / resume / retryNow / cancel).
    // Configuration does NOT travel this path any more.
    const RPC_STUB_MESSAGE = 'rpc-not-wired'
    let rpc = () => Promise.resolve({ ok: false, error: { message: RPC_STUB_MESSAGE } })
    // False until `bindRpc` swaps in a real caller, so `apply` can tell "the
    // host half is not reachable" apart from "no session is waiting".
    let rpcWired = false
    const call = (method, args) => rpc(method, args || {})
    const bindRpc = (ctx) => {
      const conn = ctx.get('connection')
      if (!conn || !conn.rpc || typeof conn.rpc.call !== 'function') {
        throw new Error('the "connection" service exposes no rpc.call')
      }
      rpc = async (method, args) => {
        const result = await conn.rpc.call('/api', 'fallbackContinue/' + method, { args: args || {} })
        if (!result || result.ok !== true) {
          const message = result && result.error && result.error.message ? result.error.message : 'request-failed'
          throw new Error(message)
        }
        return result.value
      }
      rpcWired = true
    }

    // ------------------------------------------------- shared polling store
    // One store + one 1s interval, shared by the pill and the settings page.
    let state = null
    const listeners = new Set()
    let pollTimer = null
    let pollCount = 0
    // Boot problems that must be visible instead of silent. A plugin that
    // cannot reach its host half used to sit on "載入中…" forever, which reads
    // as "the plugin is gone"; these are surfaced in the settings page AND,
    // when even that surface cannot register, in a fixed page-corner banner.
    const diagnostics = []
    const noteDiagnostic = (text) => {
      const line = String(text)
      if (diagnostics.some((d) => d.text === line)) return
      diagnostics.push({ text: line })
      renderFallbackBanner()
      notify()
    }

    // Last-resort surface: painted straight into the document, so it survives
    // a broken `slots` service. Hidden while everything is healthy.
    let fallbackBanner = null
    const renderFallbackBanner = () => {
      if (typeof document === 'undefined') return
      if (!fallbackBanner) {
        fallbackBanner = document.createElement('div')
        fallbackBanner.setAttribute('data-dsh-fbc', 'fallback-continue-diag')
        fallbackBanner.className = 'fbc-diag-banner'
        const body = document.body || document.head
        if (!body) return
        body.appendChild(fallbackBanner)
      }
      fallbackBanner.textContent = diagnostics.length + ' · ' + diagnostics[0].text
      fallbackBanner.style.display = diagnostics.length > 0 ? 'block' : 'none'
    }
    const notify = () => { for (const fn of Array.from(listeners)) fn() }
    const refresh = () => {
      call('getState').then((s) => { state = s; notify() }).catch((e) => {
        noteDiagnostic('Host RPC failed: ' + (e && e.message ? e.message : String(e)))
      })
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

    // -------------------------------------------------- session-list badges
    // No per-session-item Slot exists in the shipped workspace browser, so the
    // indicator is attached directly into each rendered `[role=treeitem]` row.
    // The row's React key (session id) is not surfaced to the DOM, so rows are
    // matched by the authoritative title from the sessions store (`s.byId`),
    // exactly as the list renders it. Badges are idempotent (one per row, kept
    // live) and removed as soon as the session drops out of the fallback set.
    //
    // IMPORTANT: the observer watches the whole <body> subtree, but sync() also
    // writes into that subtree (appendChild / textContent / remove). Those
    // self-mutations must NOT re-enter sync(), or they form an endless
    // mutation -> sync -> mutation loop that pegs the main thread (the
    // "browser freezes when clicking the sandglass row" bug). Three guards:
    //   1. a re-entrancy flag disables observer handling while syncing;
    //   2. every write is value-diff'd so a no-op sync touches nothing;
    //   3. observer callbacks are debounced, not run synchronously.
    const SessionListBadges = (props) => {
      const h = React.createElement
      const useSessions = props.useSessions
      const state = useFallbackState()
      // Read a stable sessions snapshot during render (useSessions is a hook).
      const sessionsSnap = useSessions && typeof useSessions === 'function' ? useSessions((s) => (s && s.byId ? s.byId : null)) : null

      React.useEffect(() => {
        if (typeof document === 'undefined') return
        const observed = typeof MutationObserver !== 'undefined'

        const fallbackSessions = (state && state.sessions) || []

        // Build id -> authoritative title from the sessions store snapshot.
        const titleOf = (id) => {
          const entry = sessionsSnap && sessionsSnap[id]
          if (!entry) return undefined
          if (entry.blank) return undefined
          return typeof entry.title === 'string' ? entry.title : (typeof entry.displayTitle === 'string' ? entry.displayTitle : undefined)
        }

        let syncing = false
        const sync = () => {
          if (syncing) return
          syncing = true
          try {
            const rows = Array.from(document.querySelectorAll('[role="treeitem"]'))
            const seen = new Set()
            for (const row of rows) {
              // Find the row's title span: a direct-child <span> holding text.
              let titleSpan = null
              for (const child of Array.from(row.children)) {
                if (child.tagName !== 'SPAN') continue
                if (child.getAttribute('role') === 'img') continue
                const text = (child.textContent || '').trim()
                if (text.length > 0) { titleSpan = child; break }
              }
              if (!titleSpan) continue
              const text = (titleSpan.textContent || '').trim()
              if (!text) continue

              let matchedId = null
              for (const e of fallbackSessions) {
                const ti = titleOf(e.sessionId)
                if (ti !== undefined && ti === text) { matchedId = e.sessionId; break }
              }
              if (matchedId === null) continue
              seen.add(matchedId)

              let badge = row.querySelector('[data-fbc-badge]')
              const entry = fallbackSessions.find((e) => e.sessionId === matchedId)
              const label = entry && entry.phase === 'awaiting' ? t('badgeAwaiting') : t('badgeCounting')
              const tooltip = label + (entry ? ' (#' + (entry.failures + 1) + ')' : '')
              const glyph = entry && entry.phase === 'awaiting' ? '✓' : '⏳'

              if (!badge) {
                badge = document.createElement('span')
                badge.setAttribute('data-fbc-badge', matchedId)
                badge.className = 'fbc-session-badge'
                row.appendChild(badge)
              } else if (badge.getAttribute('data-fbc-badge') !== matchedId) {
                badge.setAttribute('data-fbc-badge', matchedId)
              }
              if (badge.getAttribute('title') !== tooltip) badge.setAttribute('title', tooltip)
              if (badge.getAttribute('aria-label') !== tooltip) badge.setAttribute('aria-label', tooltip)
              if (badge.textContent !== glyph) badge.textContent = glyph
            }

            // Remove stale badges whose session is no longer in the fallback set.
            const badges = Array.from(document.querySelectorAll('[data-fbc-badge]'))
            for (const b of badges) {
              if (!seen.has(b.getAttribute('data-fbc-badge'))) b.remove()
            }
          } finally {
            syncing = false
          }
        }

        sync()

        if (!observed) return

        let pending = false
        const schedule = () => {
          if (pending || syncing) return
          pending = true
          // Coalesce the burst of mutations a click/re-render produces into one
          // sync pass on the next tick instead of re-entering synchronously.
          setTimeout(() => {
            pending = false
            sync()
          }, 0)
        }
        const observer = new MutationObserver(() => { schedule() })
        observer.observe(document.body, { childList: true, subtree: true })
        return () => { observer.disconnect() }
      }, [state, sessionsSnap])

      // Renders nothing itself; it only maintains the DOM badges.
      return null
    }

    // ------------------------------------------------------------ settings page
    // Boot problems are rendered above the form. Without this the page showed
    // "載入中…" indefinitely whenever the host half was unreachable, so a
    // broken install looked exactly like an absent plugin.
    const Diagnostics = (h) => {
      if (diagnostics.length === 0) return null
      return h('div', { className: 'fbc-diag' },
        h('div', { className: 'fbc-diag-title' }, t('diagTitle')),
        h('ul', { className: 'fbc-diag-list' },
          diagnostics.map((d, i) => h('li', { key: i }, d.text)),
        ),
      )
    }

    const SettingsPage = (props) => {
      const h = React.createElement
      const state = useFallbackState()
      const [msg, setMsg] = React.useState(null)

      // The Host's own form is the single source of truth for the draft, so the
      // inputs are controlled by it directly. Editing a text box still keeps a
      // local copy (the Host only learns the value on save) but every accepted
      // write comes back through the snapshot.
      const [draft, setDraft] = React.useState(null)
      React.useEffect(() => {
        if (configSnapshot && configSnapshot.value) setDraft(fromConfig(configSnapshot.value))
      }, [configSnapshot])

      const formUnavailable = !configSnapshot || configSnapshot.status === 'unavailable'
      const readonly = formUnavailable || configSnapshot.writable === false

      if (!state) {
        return h('div', { className: 'fbc-settings' },
          Diagnostics(h),
          state === null && diagnostics.length === 0
            ? h('p', null, t('loading'))
            : null,
        )
      }
      if (!draft) {
        return h('div', { className: 'fbc-settings' },
          Diagnostics(h),
          h('p', null, configSnapshot && configSnapshot.status === 'loading' ? t('loading') : t('settingsUnavailable')),
        )
      }

      // One field -> one queued Host write. `setConfigField` resolves with the
      // Host's acceptance; the snapshot then re-renders with the stored value.
      const saveField = async (field, value) => {
        setMsg(null)
        try {
          const accepted = await setConfigField(field, value)
          if (!accepted) setMsg(t('saveRejected'))
        } catch (e) {
          setMsg(t('saveFailed') + '：' + (e && e.message ? e.message : String(e)))
        }
      }

      const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

      const saveIntervals = async () => {
        const arr = parseIntervals(draft.intervalsText)
        if (arr === null) { setMsg(t('intervalsInvalid')); return }
        await saveField('retryIntervalsMinutes', arr)
      }

      return h('div', { className: 'fbc-settings' },
        h('h3', null, t('title')),
        readonly ? h('p', { className: 'fbc-muted' }, t('settingsReadonly')) : null,
        h('label', { className: 'fbc-row fbc-toggle' },
          h('input', { type: 'checkbox', disabled: readonly, checked: !!draft.enabled, onChange: (ev) => saveField('enabled', ev.target.checked) }),
          h('span', null, t('enable')),
        ),
        h('div', { className: 'fbc-field' },
          h('label', { className: 'fbc-label' }, t('continueText')),
          h('input', { className: 'fbc-input', type: 'text', disabled: readonly, value: draft.continueText, onChange: (ev) => setDraft({ ...draft, continueText: ev.target.value }) }),
          h('button', { className: 'fbc-btn', disabled: readonly, onClick: () => saveField('continueText', draft.continueText) }, t('save')),
        ),
        h('div', { className: 'fbc-field' },
          h('label', { className: 'fbc-label' }, t('intervals')),
          h('input', { className: 'fbc-input', type: 'text', disabled: readonly, value: draft.intervalsText, onChange: (ev) => setDraft({ ...draft, intervalsText: ev.target.value }) }),
          h('button', { className: 'fbc-btn', disabled: readonly, onClick: saveIntervals }, t('save')),
        ),
        h('label', { className: 'fbc-row fbc-toggle' },
          h('input', { type: 'checkbox', disabled: readonly, checked: !!draft.capEnabled, onChange: (ev) => saveField('capEnabled', ev.target.checked) }),
          h('span', null, t('capEnable')),
        ),
        h('div', { className: 'fbc-field' },
          h('label', { className: 'fbc-label' }, t('capHours')),
          h('input', { className: 'fbc-input', type: 'number', min: 0, disabled: readonly, value: String(draft.capHours), onChange: (ev) => setDraft({ ...draft, capHours: ev.target.value }) }),
          h('button', { className: 'fbc-btn', disabled: readonly, onClick: () => saveField('capHours', Math.max(0, num(draft.capHours))) }, t('save')),
        ),
        h('div', { className: 'fbc-field' },
          h('label', { className: 'fbc-label' }, t('cooldown')),
          h('input', { className: 'fbc-input', type: 'number', min: 1, disabled: readonly, value: String(draft.cooldownMinutes), onChange: (ev) => setDraft({ ...draft, cooldownMinutes: ev.target.value }) }),
          h('button', { className: 'fbc-btn', disabled: readonly, onClick: () => saveField('cooldownMinutes', Math.max(1, num(draft.cooldownMinutes))) }, t('save')),
        ),
        waitList(state, h),
        msg ? h('p', { className: 'fbc-msg' }, msg) : null,
        Diagnostics(h),
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
                '#' + (e.failures + 1) + ' · ' + phaseText +
                (e.cooling ? ' · ' + t('cooling') : '') +
                (e.heldCount > 0 ? t('heldSuffix') + e.heldCount + t('heldSuffixEnd') : '') +
                ' · ' + (e.reason || 'error')),
            ),
            h('div', { className: 'fbc-list-actions' },
              e.phase === 'counting'
                ? h('button', { className: 'fbc-btn', onClick: () => (e.paused ? call('resume', { sessionId: e.sessionId }) : call('pause', { sessionId: e.sessionId })) }, e.paused ? t('resume') : t('pause'))
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
      '.fbc-session-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; margin-left: 6px; padding: 0 4px; font-size: 11px; line-height: 1; color: #fff; background: var(--dsw-alias-state-warn-primary, #ff9a3d); border-radius: 8px; flex: none; font-family: system-ui, -apple-system, sans-serif; }',
      '.fbc-msg { color: var(--dsw-alias-state-error-primary, #ff8a8a); font-size: 12px; }',
      '.fbc-diag { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--dsw-alias-state-error-primary, #ff8a8a); border-radius: 8px; background: var(--dsw-alias-state-error-container, rgba(255,90,90,0.08)); color: var(--dsw-alias-state-error-primary, #ff9a9a); font-size: 12px; line-height: 1.5; }',
      '.fbc-diag-title { font-weight: 600; margin-bottom: 6px; }',
      '.fbc-diag-list { margin: 0; padding-left: 18px; }',
      '.fbc-diag-list li { margin: 2px 0; word-break: break-word; }',
      '.fbc-diag-banner { position: fixed; left: 16px; bottom: 16px; z-index: 10001; display: none; max-width: 380px; padding: 8px 12px; border: 1px solid var(--dsw-alias-state-error-primary, #ff8a8a); border-radius: 8px; background: rgba(20,20,28,0.95); color: var(--dsw-alias-state-error-primary, #ff9a9a); font-size: 12px; line-height: 1.4; font-family: system-ui, -apple-system, sans-serif; box-shadow: var(--dsw-shadow-lv3, 0 4px 16px rgba(0,0,0,0.4)); }',
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
    // `remote` + `configForms` carry configuration (the Host's own settings
    // form for this entry's namespace); `connection` still carries session
    // state over the plugin's Remote service.
    const inject = ['slots', 'connection', 'remote', 'configForms']

    // Run one optional piece of the UI. A failure here is recorded and shown in
    // the settings page instead of aborting `apply`: previously the first
    // throw (a missing service, a changed slots contract, a headless page)
    // killed every later registration, so the plugin vanished with no trace.
    const guard = (label, fn) => {
      try {
        return fn()
      } catch (error) {
        noteDiagnostic(label + ': ' + (error && error.message ? error.message : String(error)))
        return undefined
      }
    }

    function apply(ctx) {
      guard('RPC binding', () => bindRpc(ctx))
      if (!rpcWired) {
        noteDiagnostic('The "connection" service is unavailable, so session state cannot be read. Check that the dsh-plugin-fallback-continue host plugin is enabled in cordis.patch.yml.')
      }

      // Configuration is optional: without it the page still renders and still
      // shows session state, it just cannot save. That is better than refusing
      // to mount, and the reason is reported instead of swallowed.
      guard('Settings form', () => bindConfigForm(ctx))
      if (configForm && configSnapshot.status === 'unavailable') {
        noteDiagnostic('The Host exposes no settings form for namespace "' + SETTINGS_NS + '". Check that this plugin\'s cordis.patch.yml entry uses `id: ' + SETTINGS_NS + '` and that the host plugin is enabled.')
      }

      const locale = ctx.get('locale')
      if (locale !== undefined) {
        guard('Locale registration', () => {
          ctx.effect(() => locale.register('fallback-continue', 'zh', zh))
          ctx.effect(() => locale.register('fallback-continue', 'en', en))
          t = locale.bind('fallback-continue')
        })
      }

      guard('Stylesheet', () => { ctx.effect(() => injectCss(CSS), 'fallback-continue: styles') })

      const slots = ctx.get('slots')
      if (slots === undefined) {
        noteDiagnostic('The "slots" service is unavailable, so the settings page and floating pill cannot be registered.')
        return
      }

      guard('Floating pill', () => {
        ctx.effect(() => slots.inject('shell.overlay', () => guard('Floating pill', () => slots.register(
          { name: 'shell.overlay', id: 'fallback-continue-pill', order: 500 },
          Pill,
        ))), 'fallback-continue: pill')
      })

      guard('Session-list badges', () => {
        ctx.effect(() => slots.inject('shell.overlay', () => guard('Session-list badges', () => slots.register(
          { name: 'shell.overlay', id: 'fallback-continue-list-badges', order: 100 },
          SessionListBadges,
        ))), 'fallback-continue: list-badges')
      })

      guard('Settings section', () => {
        ctx.effect(() => slots.inject('settings.section', () => guard('Settings section', () => slots.register(
          { name: 'settings.section', id: 'fallback-continue', order: 30, label: () => t('title') },
          SettingsPage,
        ))), 'fallback-continue: settings')
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})