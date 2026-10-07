/**
 * dsh-multiview — Client half.
 *
 * A classic-script, factory-form CJS module loaded by the shell's module
 * loader. It registers three things:
 *
 *  - `shell.overlay` — the browser-style tab strip, the sub-interface layer,
 *    and the floating "torn-off" window frames.
 *  - `conversation.composer.dock` — the pinned chips below the composer, so a
 *    sub-interface the user pins is one click away from the new-conversation
 *    input.
 *  - `settings.section` — this plugin's own settings page.
 *
 * ## What each user-facing behaviour is built on
 *
 *  - **Isolation** is the Host half's job (one child `dsh` process and profile
 *    per sub-interface); this half only chooses which sub-interface is visible.
 *  - **Sub-interface display** is an `<iframe>` pointing at the Host's own
 *    `/mv/<id>/` mount, which the Host proxies to that sub-interface's child
 *    host. Because the child is a different document, its plugins, styles, and
 *    scripts are genuinely separate from the main interface's.
 *  - **Closing a sub-interface** removes its tab and stops its child host,
 *    leaving the main interface untouched. The main interface's own tab has no
 *    close control at all.
 *  - **Tear-off into a real separate window** uses `window.open(url)`. The
 *    desktop shell answers an http(s) `window.open` by handing the URL to the
 *    operating system (`shell.openExternal`), so a sub-interface, the main
 *    interface, a file, or the settings page opens as a genuine separate
 *    window. No URL is invented in the page: the Host mints them, and the file
 *    viewer's is a one-shot ticket.
 *
 * @module dsh-multiview/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-multiview',
  factory(require) {
    const React = require('react')
    const { createRoot } = require('react-dom/client')
    const h = React.createElement

    /** Host API root. */
    const API = '/mv/api'
    /** How long a press must be held before it becomes a drag. */
    const LONG_PRESS_MS = 320
    /** How far a drag must travel before releasing tears the item off. */
    const TEAR_OFF_PX = 48
    /** localStorage key for the tab set. */
    const STORAGE_KEY = 'dsh-multiview.v1'
    /**
     * Height of the tab strip, in px.
     *
     * The strip occupies a band of its own rather than floating over the client:
     * the frame's `padding-top` grows by exactly this much while the strip is
     * open, so the columns below start under it. The value is mirrored in
     * {@link CSS} (`.mv-strip{height:36px}`) and the two must agree.
     */
    const STRIP_H = 36
    /** The Windows caption menubar the desktop preload injects, if present. */
    const MENU_SELECTOR = '[data-windows-menu]'

    // -----------------------------------------------------------------------
    // Host API
    // -----------------------------------------------------------------------

    /** POST a JSON body to the plugin's own Host route. */
    async function post(path, body) {
      const response = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const value = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(value?.error ?? `multiview: ${path} failed with HTTP ${String(response.status)}`)
      return value
    }

    /** GET a JSON value from the plugin's own Host route. */
    async function get(path) {
      const response = await fetch(`${API}${path}`)
      const value = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(value?.error ?? `multiview: ${path} failed with HTTP ${String(response.status)}`)
      return value
    }

    // -----------------------------------------------------------------------
    // Persistence
    // -----------------------------------------------------------------------

    /**
     * The default tab set: the main interface alone, with the strip open.
     *
     * `stripOpen` is persisted state, not component state, and that is the point:
     * closing the strip hides the control that reopens it, so an unpersisted
     * flag would strand the user until a page reload. It is restored on every
     * activation, and the caption button that toggles it stays visible whether
     * the strip is open or closed.
     */
    function defaultState() {
      return {
        tabs: [{ id: 'main', kind: 'main', label: '主页', pinnedTab: true, pinnedComposer: false }],
        activeId: 'main',
        stripOpen: true,
      }
    }

    /** Read the persisted tab set, tolerating any corruption. */
    function loadState() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (raw === null) return defaultState()
        const parsed = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.tabs)) return defaultState()
        const tabs = parsed.tabs.filter((tab) => typeof tab?.id === 'string' && (tab.kind === 'main' || tab.kind === 'view'))
        if (!tabs.some((tab) => tab.kind === 'main')) tabs.unshift(defaultState().tabs[0])
        // The main interface is always pinned in the strip and never pinned below
        // the composer — it has no close control, so it cannot be dismissed, and a
        // second placement for it would only duplicate it. State persisted by an
        // older build (or by a press on a control that no longer exists) may say
        // otherwise, so it is normalised on every load rather than merely defaulted.
        for (const tab of tabs) {
          if (tab.kind !== 'main') continue
          tab.pinnedTab = true
          tab.pinnedComposer = false
          // The main tab's NAME is not user-editable (renaming only ever
          // applied to view tabs), so a stored label is a stale leftover from
          // an older build's wording. Force the current name.
          tab.label = '主页'
        }
        const activeId = tabs.some((tab) => tab.id === parsed.activeId) ? parsed.activeId : 'main'
        return { tabs, activeId, stripOpen: parsed.stripOpen !== false }
      } catch {
        return defaultState()
      }
    }

    /** Persist the tab set. */
    function saveState(state) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
          tabs: state.tabs,
          activeId: state.activeId,
          stripOpen: state.stripOpen !== false,
        }))
      } catch {
        /* storage unavailable: the session still works, it just will not persist */
      }
    }

    // -----------------------------------------------------------------------
    // Favorite sub-interfaces (常用)
    // -----------------------------------------------------------------------

    /**
     * The favorite list lives on the HOST (`$DSH_HOME/multiview/favorites.json`),
     * not in localStorage. That is what makes it SHARED: the main window and
     * every independent-mode browser window read and write the same list
     * through /mv/api/favorites, so a favorite added anywhere shows up
     * everywhere.
     *
     * The helpers below are async (they hit the Host); components keep a local
     * React copy for rendering and refresh it after every toggle.
     */

    /** Fetch the shared favorite list. */
    async function fetchFavorites() {
      try {
        const value = await get('/favorites')
        return Array.isArray(value?.favorites) ? value.favorites : []
      } catch {
        return []
      }
    }

    /** Toggle one id in the shared list; resolves with the new list. */
    async function toggleFavoriteOnHost(id) {
      const value = await post('/favorites', { id })
      return Array.isArray(value?.favorites) ? value.favorites : []
    }

    // -----------------------------------------------------------------------
    // Styles
    // -----------------------------------------------------------------------

    /**
     * Every colour comes from a host theme token, so the plugin follows the
     * active light/dark theme and any custom skin. The literal fallbacks are
     * only reached on a page that publishes no tokens at all.
     */
    const CSS = `
/* Reserve the strip's band on the frame itself.
   The shipped layout already pushes its columns down by
   --dsh-windows-titlebar-height through a padding-top on the frame, so growing
   that same padding is how the strip gets a band of its own: the columns start
   below it and nothing is covered. The rule needs !important because the
   shipped one is a two-selector rule ([data-windows-titlebar] .frame). */
.mv-band{padding-top:calc(var(--mv-top,0px) + var(--mv-band-h,0px)) !important}
.mv-strip{position:absolute;inset-inline:0;top:var(--mv-top,0px);height:36px;display:flex;align-items:center;gap:2px;
  padding:0 6px;background:var(--dsw-alias-bg-layer-1,#1b1b22);border-bottom:1px solid var(--dsw-alias-border-l1,#2c2d36);
  pointer-events:auto;z-index:30;-webkit-app-region:no-drag;
  font:12px/1 ui-sans-serif,system-ui,"Segoe UI",sans-serif;color:var(--dsw-alias-label-primary,#f9fafb)}
.mv-strip[data-hidden="true"]{display:none}
/* The caption controls sit in the window's top band, beside the shell's own
   应用/编辑 menubar. --mv-caption-left is measured from that menubar's right
   edge, so the two never overlap.

   Type and metrics deliberately match that menubar's own buttons -- 14px in the
   shared font family, 28px tall with 10px of padding -- so the row reads as one
   control strip rather than as a plugin widget bolted onto it. */
.mv-caption{position:fixed;top:0;left:var(--mv-caption-left,8px);height:var(--mv-caption-h,40px);display:flex;align-items:center;gap:2px;
  z-index:1100;-webkit-app-region:no-drag;pointer-events:auto;
  font-family:var(--dsw-font-family,ui-sans-serif,system-ui,"Segoe UI",sans-serif);font-size:14px;line-height:1;
  color:var(--dsw-alias-label-secondary,#9aa1ad)}
/* With no shell menubar to sit beside, the control draws its own pill so it
   stays legible against whatever the page renders underneath. */
.mv-caption[data-standalone="true"]{height:auto;padding:3px;border-radius:6px;
  background:var(--dsw-alias-bg-layer-1,#1b1b22);border:1px solid var(--dsw-alias-border-l1,#2c2d36)}
.mv-caption-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:0;border-radius:6px;
  background:transparent;color:inherit;font:inherit;font-size:14px;cursor:pointer;white-space:nowrap}
.mv-caption-btn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,#22232b));color:var(--dsw-alias-label-primary,#f9fafb)}
.mv-caption-btn[data-on="true"]{color:var(--dsw-alias-label-primary,#f9fafb)}
/* The strip switch: the shell's own panel-left glyph, turned a quarter turn
   clockwise so its divider runs along the top edge and opens from the left --
   the same shape as the band the switch controls. The glyph is square, so the
   90° turn never changes its 16px box and the caption metrics are untouched. */
.mv-caption-btn[data-icon="true"]{padding:0 7px}
.mv-caption-glyph{display:block;width:16px;height:16px;flex:none;transform:rotate(90deg);transform-origin:center}
.mv-caption-count{min-width:15px;height:15px;padding:0 4px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;
  background:var(--dsw-alias-bg-layer-2,#22232b);color:var(--dsw-alias-label-secondary,#9aa1ad);font-size:10px}
/* The tab menu drops out of the caption band, under the 标签 button. It reuses
   --mv-caption-left so it is always anchored to the controls above it.
   The width fits the widest row: a sub-interface's name plus its five action
   buttons. It has a ceiling so a long name cannot push the menu past the
   viewport, which is why the name itself ellipsizes. */
/* The menu uses the SAME surface material as the app's own menus: the theme's
   translucent menu-surface fill + the official backdrop blur, both of which
   flip with the light/dark choice in the general appearance settings. The dark
   theme's stroke token is what the official menu carries; the opaque fallbacks
   only fire on a page that publishes no tokens at all. */
.mv-menu{position:fixed;top:calc(var(--mv-caption-h,40px) - 4px);left:var(--mv-caption-left,8px);z-index:1101;
  min-width:210px;max-width:min(500px,94vw);padding:4px;
  border-radius:8px;background:var(--dsw-specific-menu,var(--dsw-menu-surface-fill,#26272f));
  backdrop-filter:var(--dsw-menu-backdrop-filter,none);
  border:0;box-shadow:var(--dsw-elevation-panel,0 12px 32px rgba(0,0,0,.4));
  font:12px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif;color:var(--dsw-alias-label-primary,#f9fafb)}
.mv-menu-item{display:flex;align-items:center;gap:8px;width:100%;height:28px;padding:0 8px;border:0;border-radius:5px;
  background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;white-space:nowrap}
.mv-menu-item:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,#22232b))}
.mv-menu-item[disabled]{opacity:.4;cursor:default}
.mv-menu-item[data-danger="true"]:hover:not([disabled]){background:var(--dsw-alias-state-error-primary,#ef4444);color:#fff}
.mv-menu-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1,#2c2d36)}
.mv-menu-hint{padding:2px 8px 4px;color:var(--dsw-alias-label-secondary,#9aa1ad);font-size:11px}
.mv-menu-hint[data-error="true"]{color:var(--dsw-alias-state-error-primary,#ef4444)}
/* One row per sub-interface in the management section. The rows are wider than
   the plain menu items, so the menu itself grows to fit them rather than
   wrapping the buttons onto a second line. */
.mv-manage{display:flex;flex-direction:column;gap:2px;padding:2px 0}
.mv-manage-row{display:flex;align-items:center;gap:4px;padding:0 6px}
.mv-manage-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-primary,#f9fafb);font-size:12px}
.mv-manage-btn{height:22px;padding:0 7px;border:0;border-radius:4px;background:transparent;
  color:var(--dsw-alias-label-secondary,#9aa1ad);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}
.mv-manage-btn:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,#22232b));
  color:var(--dsw-alias-label-primary,#f9fafb)}
.mv-manage-btn[disabled]{opacity:.4;cursor:default}
.mv-manage-btn[data-danger="true"]:hover:not([disabled]){background:var(--dsw-alias-state-error-primary,#ef4444);color:#fff}
.mv-rename{height:20px;min-width:70px;max-width:150px;padding:0 4px;border-radius:4px;border:1px solid var(--dsw-alias-brand-primary,#247bbf);
  background:var(--dsw-alias-bg-base,#101116);color:var(--dsw-alias-label-primary,#f9fafb);font:inherit;outline:none}
.mv-tab{display:flex;align-items:center;gap:6px;height:26px;max-width:210px;padding:0 4px 0 9px;border-radius:6px;cursor:default;
  color:var(--dsw-alias-label-secondary,#9aa1ad);background:transparent;border:1px solid transparent;user-select:none;white-space:nowrap}
.mv-tab:hover{background:var(--dsw-alias-bg-layer-2,#22232b)}
.mv-tab[data-active="true"]{color:var(--dsw-alias-label-primary,#f9fafb);background:var(--dsw-alias-bg-overlay,#26272f);border-color:var(--dsw-alias-border-l1,#2c2d36)}
.mv-tab[data-pinned="true"] .mv-tab-label{font-weight:600}
.mv-tab[data-armed="true"]{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:-1px}
.mv-tab[data-drop="true"]{box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary,#247bbf)}
.mv-tab[data-dragging="true"]{opacity:.55}
.mv-tab-label{overflow:hidden;text-overflow:ellipsis;max-width:140px}
.mv-tab-state{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#6b7280);flex:none}
.mv-tab-state[data-state="running"]{background:var(--dsw-alias-state-success-primary,#22c55e)}
.mv-tab-state[data-state="starting"]{background:var(--dsw-alias-state-warn-primary,#f59e0b)}
.mv-tab-state[data-state="failed"]{background:var(--dsw-alias-state-error-primary,#ef4444)}
.mv-icon{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px;border:0;
  background:transparent;color:inherit;cursor:pointer;font:inherit;line-height:1;padding:0;opacity:.75}
.mv-icon:hover{background:var(--dsw-alias-bg-layer-2,#22232b);opacity:1}
.mv-icon[data-on="true"]{opacity:1;color:var(--dsw-alias-brand-primary,#247bbf)}
.mv-spacer{flex:1}
.mv-ghost{position:fixed;z-index:2147483000;pointer-events:none;padding:5px 10px;border-radius:6px;font:12px/1.4 ui-sans-serif,system-ui,sans-serif;
  color:var(--dsw-alias-label-primary,#f9fafb);background:var(--dsw-alias-bg-overlay,#26272f);
  border:1px solid var(--dsw-alias-brand-primary,#247bbf);box-shadow:0 8px 24px rgba(0,0,0,.35);max-width:320px}
/* The sub-interface layer starts below BOTH the caption band and the strip's
   band. The overlay layer spans the whole frame including its padding, so
   without the band term the top of the embedded client would sit underneath the
   strip instead of below it. */
.mv-layer{position:absolute;inset:0;top:calc(var(--mv-top,0px) + var(--mv-band-h,0px));pointer-events:auto;background:var(--dsw-alias-bg-base,#101116);z-index:20;display:flex;flex-direction:column}
.mv-layer[data-hidden="true"]{display:none}
.mv-frame{flex:1;width:100%;border:0;background:var(--dsw-alias-bg-base,#101116)}
.mv-notice{display:flex;flex-direction:column;gap:10px;align-items:flex-start;justify-content:center;height:100%;padding:24px;
  color:var(--dsw-alias-label-secondary,#9aa1ad);font:13px/1.6 ui-sans-serif,system-ui,sans-serif}
.mv-notice strong{color:var(--dsw-alias-label-primary,#f9fafb);font-size:14px}
.mv-button{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border-radius:6px;cursor:pointer;font:12px/1 ui-sans-serif,system-ui,sans-serif;
  color:var(--dsw-alias-label-primary,#f9fafb);background:var(--dsw-alias-bg-layer-2,#22232b);border:1px solid var(--dsw-alias-border-l1,#2c2d36)}
.mv-button:hover{background:var(--dsw-alias-bg-overlay,#26272f)}
.mv-button[disabled]{opacity:.5;cursor:default}
.mv-dock{display:flex;flex-wrap:wrap;gap:6px;padding:2px 0;pointer-events:auto}
.mv-chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:11px;cursor:pointer;
  color:var(--dsw-alias-label-secondary,#9aa1ad);background:var(--dsw-alias-bg-layer-2,#22232b);border:1px solid var(--dsw-alias-border-l1,#2c2d36);
  font:11px/1 ui-sans-serif,system-ui,sans-serif;white-space:nowrap}
.mv-chip:hover{color:var(--dsw-alias-label-primary,#f9fafb);border-color:var(--dsw-alias-brand-primary,#247bbf)}
.mv-chip-window{padding:0 6px}
.mv-dock-error{font:11px/1.5 ui-sans-serif,system-ui,sans-serif;color:var(--dsw-alias-label-error,#e5484d)}
.mv-settings{display:flex;flex-direction:column;gap:14px;padding:4px 0;font:13px/1.6 ui-sans-serif,system-ui,sans-serif;color:var(--dsw-alias-label-primary,#f9fafb)}
.mv-settings h3{margin:0;font-size:13px;font-weight:600}
.mv-settings p{margin:0;color:var(--dsw-alias-label-secondary,#9aa1ad)}
.mv-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#2c2d36)}
.mv-row:last-child{border-bottom:0}
.mv-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa1ad);
  word-break:break-all}
`

    /** Inject the stylesheet once per activation; removed on disposal. */
    function useStyles() {
      return React.useEffect(() => {
        const element = document.createElement('style')
        element.setAttribute('data-plugin', 'dsh-multiview')
        element.textContent = CSS
        document.head.appendChild(element)
        return () => { element.remove() }
      }, [])
    }

    // -----------------------------------------------------------------------
    // Long-press drag
    // -----------------------------------------------------------------------

    /**
     * Arm a long-press on an element. After {@link LONG_PRESS_MS} the press
     * becomes a drag: the caller shows a ghost, and releasing past
     * {@link TEAR_OFF_PX} invokes `onTearOff`.
     *
     * A short press or a release without travel is a plain click and calls
     * `onClick`, so the same control both activates and tears off — which is
     * what "长按可以拖动为单独窗口" asks for.
     *
     * `canTearOff: false` keeps the click and drops the tear-off entirely — no
     * arm timer, no ghost, no release action. The main interface uses it: it has
     * no window action of its own.
     *
     * @returns a React `onPointerDown` handler.
     */
    function useLongPress({ label, onClick, onTearOff, canTearOff = true }) {
      const state = React.useRef({ timer: 0, armed: false, dragging: false, startX: 0, startY: 0, pointerId: -1 })
      const [, force] = React.useState(0)

      const cleanup = React.useCallback(() => {
        const current = state.current
        if (current.timer !== 0) window.clearTimeout(current.timer)
        current.timer = 0
        current.armed = false
        current.dragging = false
        current.pointerId = -1
        document.querySelectorAll('[data-mv-ghost]').forEach((node) => node.remove())
        force((value) => value + 1)
      }, [])

      React.useEffect(() => cleanup, [cleanup])

      const onPointerDown = React.useCallback((event) => {
        if (event.button !== 0) return
        const current = state.current
        current.startX = event.clientX
        current.startY = event.clientY
        current.pointerId = event.pointerId
        current.armed = false
        current.dragging = false
        if (canTearOff) {
          current.timer = window.setTimeout(() => {
            current.armed = true
            force((value) => value + 1)
          }, LONG_PRESS_MS)
        }

        const ghost = () => {
          const node = document.createElement('div')
          node.setAttribute('data-mv-ghost', '')
          node.className = 'mv-ghost'
          node.textContent = `${label}  →  松开即在新窗口打开`
          document.body.appendChild(node)
          return node
        }
        let ghostNode = null

        const onMove = (moveEvent) => {
          if (!current.armed) {
            // Moving before the press is armed cancels it: that gesture is a
            // text selection or a scroll, not a tear-off.
            if (Math.hypot(moveEvent.clientX - current.startX, moveEvent.clientY - current.startY) > 6) cleanup()
            return
          }
          if (!current.dragging) {
            current.dragging = true
            ghostNode = ghost()
          }
          if (ghostNode !== null) {
            ghostNode.style.left = `${String(moveEvent.clientX + 12)}px`
            ghostNode.style.top = `${String(moveEvent.clientY + 12)}px`
          }
        }

        const onUp = (upEvent) => {
          window.removeEventListener('pointermove', onMove, true)
          window.removeEventListener('pointerup', onUp, true)
          window.removeEventListener('pointercancel', onUp, true)
          const wasDragging = current.dragging
          const travel = Math.hypot(upEvent.clientX - current.startX, upEvent.clientY - current.startY)
          cleanup()
          if (wasDragging && travel >= TEAR_OFF_PX) onTearOff?.()
          else onClick?.()
        }

        window.addEventListener('pointermove', onMove, true)
        window.addEventListener('pointerup', onUp, true)
        window.addEventListener('pointercancel', onUp, true)
      }, [label, onClick, onTearOff, canTearOff, cleanup])

      return { onPointerDown, armed: state.current.armed }
    }

    // -----------------------------------------------------------------------
    // Tear-off
    // -----------------------------------------------------------------------

    /**
     * Open a URL as a real separate window.
     *
     * The desktop shell's window-open handler answers an http(s) URL by handing
     * it to the operating system, which is how this becomes a genuine separate
     * window rather than another in-app panel. The URL always comes from the
     * Host half, which is also what keeps the child's launch token and the file
     * viewer's one-shot ticket out of the page's own state.
     */
    function openWindow(url) {
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
        window.alert(`multiview: refusing to open a non-http URL: ${String(url)}`)
        return
      }
      const opened = window.open(url, '_blank', 'noopener,noreferrer')
      // A plain browser tab (not the desktop shell) would return a window here;
      // nothing to do either way, the URL is already handed over.
      void opened
    }

    /**
     * Ask the Host to open one target in a real operating-system window.
     *
     * `/window` is the current endpoint: the Host launches a Chromium app window
     * with a dedicated browser profile, tracks the process so it can report and
     * close it, and gives it a scoped session cookie. A Host half from before
     * that endpoint answers 404, so this falls back to the shell's external-open
     * path — a plain browser tab rather than an app window, which is worse but
     * not nothing. The client half reloads on a page refresh while the Host half
     * only reloads on an application restart, so that gap is real and expected.
     *
     * @param id - a sub-interface id, or `main`.
     * @returns which shape was opened.
     */
    async function requestWindow(id) {
      try {
        await post('/window', { id })
        return 'app-window'
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/HTTP 404/.test(message)) throw error
        if (id === 'main') {
          const value = await post('/self-url', {})
          openWindow(value.url)
          return 'browser-tab'
        }
        const value = await post('/external-url', { id })
        openWindow(value.url)
        return 'browser-tab'
      }
    }

    // -----------------------------------------------------------------------
    // Main application
    // -----------------------------------------------------------------------

    /**
     * The whole plugin UI. One instance per activation, created by `apply`.
     *
     * All tab state lives in the shared `store` rather than in component state,
     * so the tab strip, the pinned composer chips, and the settings page always
     * agree about which sub-interface is active and what is pinned.
     *
     * @param props.ctx - the client cordis context.
     * @param props.store - the per-activation tab store.
     */
    function MultiView(props) {
      const { ctx, store } = props
      useStyles()
      const [state, setState] = React.useState(store.get())
      const [views, setViews] = React.useState({})
      /** Host-owned switch for the long-press-a-workspace gesture (see `refresh`). */
      const workspaceWindows = React.useRef(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [message, setMessage] = React.useState('')
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [renaming, setRenaming] = React.useState('')
      const [dragId, setDragId] = React.useState('')
      const [dropId, setDropId] = React.useState('')
      /**
       * Per-sub-interface frame generation, bumped to remount an iframe.
       *
       * A sub-interface that was restarted gets a new child process on a new port
       * with a new cookie, while its mount path is unchanged — so the old
       * document inside the frame would keep talking to a backend that is gone.
       * Changing the `key` is what forces a fresh document load at the same `src`.
       */
      const [reloadKeys, setReloadKeys] = React.useState({})
      /** Whether no shell menubar exists, so the control draws its own pill. */
      const [standalone, setStandalone] = React.useState(false)
      /** Shared favorite list (Host-persisted; same list in every window). */
      const [favorites, setFavorites] = React.useState([])

      const stripOpen = state.stripOpen !== false

      /** Force the iframe showing `id` to reload on its next render. */
      const bumpReload = React.useCallback((id) => {
        setReloadKeys((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }))
      }, [])

      /** Favorite or unfavorite a sub-interface (the tab's ☆/⭐ control). */
      const toggleTabFavorite = React.useCallback(async (id) => {
        try {
          setFavorites(await toggleFavoriteOnHost(id))
        } catch {
          /* host unreachable: the star just does not flip this once */
        }
      }, [])

      // Load the shared favorite list (and refresh with the same cadence as
      // the view states, so another window's change shows up here too).
      React.useEffect(() => {
        let live = true
        const load = async () => {
          const next = await fetchFavorites()
          if (live) setFavorites(next)
        }
        void load()
        const timer = window.setInterval(() => { void load() }, 4000)
        return () => { live = false; window.clearInterval(timer) }
      }, [])

      // Follow the shared store, which the pinned chips and the settings page
      // also write to.
      React.useEffect(() => store.subscribe(setState), [store])

      /**
       * Keep the strip clear of the desktop shell's caption band, and make the
       * frame reserve a band for the strip itself.
       *
       * The shell stamps `--dsh-windows-titlebar-height` on <html> and pushes
       * its columns down by exactly that much through a `padding-top` on the
       * frame. The strip cannot simply float over the columns -- that would
       * cover the top of the client. Instead the frame's own `padding-top` is
       * grown by the strip's height while the strip is open, so the columns
       * start below the strip and nothing is covered. Both the caption band and
       * the strip height are published as CSS variables, and the layer offset
       * follows, so the whole thing stays in one place.
       */
      React.useEffect(() => {
        const root = document.documentElement
        const measure = () => {
          const stamped = Number.parseFloat(getComputedStyle(root).getPropertyValue('--dsh-windows-titlebar-height'))
          // A frameless shell reserves the top band as a drag region; a page
          // that is not the desktop shell reserves nothing.
          const caption = Number.isFinite(stamped) && stamped > 0
            ? stamped
            : (root.dataset.platform === 'win32' ? 40 : 0)
          root.style.setProperty('--mv-top', `${String(caption)}px`)
          root.style.setProperty('--mv-caption-h', `${String(caption || 40)}px`)
        }
        measure()
        const observer = new MutationObserver(measure)
        observer.observe(root, { attributes: true, attributeFilter: ['data-platform', 'data-fullscreen', 'data-windows-titlebar', 'style'] })
        return () => { observer.disconnect() }
      }, [])

      // Reserve the strip's own band on the frame, and release it when closed.
      //
      // `shell.overlay` renders inside the layout's overlay layer, which is an
      // absolutely positioned child of the frame, so the frame is the overlay's
      // own parent element. Growing that element's `padding-top` is what pushes
      // every column down; the overlay itself covers the whole padding box, so
      // the strip can sit inside the reserved band.
      React.useEffect(() => {
        const root = document.documentElement
        const overlay = document.querySelector('[data-shell-overlay]')
        const frame = overlay?.parentElement ?? null
        const band = stripOpen ? STRIP_H : 0
        root.style.setProperty('--mv-band-h', `${String(band)}px`)
        if (frame !== null) frame.classList.toggle('mv-band', stripOpen)
        return () => {
          root.style.setProperty('--mv-band-h', '0px')
          if (frame !== null) frame.classList.remove('mv-band')
        }
      }, [stripOpen])

      // Place the caption control just right of the shell's own menubar, so the
      // tab switch sits beside 应用/编辑 instead of on top of them. The preload
      // publishes the menubar's left offset through `--dsh-windows-menu-start`;
      // measuring the element directly is more robust, because that variable is
      // a styling detail while the element is the thing on screen. When no
      // menubar exists (a plain browser tab) the control falls back to the left
      // edge and draws its own background so it stays legible.
      React.useEffect(() => {
        const root = document.documentElement
        const place = () => {
          const menu = document.querySelector(MENU_SELECTOR)
          if (menu === null) {
            root.style.setProperty('--mv-caption-left', '8px')
            setStandalone(true)
            return
          }
          setStandalone(false)
          const rect = menu.getBoundingClientRect()
          // Fall back to the published start offset while the shadow host has no
          // box yet, which is the state before the shell's first paint.
          const right = rect.width > 0
            ? rect.right
            : Number.parseFloat(getComputedStyle(root).getPropertyValue('--dsh-windows-menu-start')) || 48
          root.style.setProperty('--mv-caption-left', `${String(Math.round(right + 8))}px`)
        }
        place()
        const observer = new MutationObserver(place)
        observer.observe(document.body, { childList: true, subtree: true })
        window.addEventListener('resize', place)
        return () => { observer.disconnect(); window.removeEventListener('resize', place) }
      }, [])

      const active = state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0]

      /** Replace the tab set in the shared store. */
      const update = React.useCallback((mutate) => {
        const previous = store.get()
        const next = mutate({ tabs: [...previous.tabs], activeId: previous.activeId, stripOpen: previous.stripOpen !== false })
        store.set(next)
      }, [store])

      /** Open or close the tab strip. The choice is persisted. */
      const setStripOpen = React.useCallback((open) => {
        update((current) => { current.stripOpen = open; return current })
      }, [update])

      /** Move a tab to another position, which is how tabs are reordered. */
      const moveTab = React.useCallback((fromId, toId) => {
        if (fromId === toId) return
        update((current) => {
          const from = current.tabs.findIndex((tab) => tab.id === fromId)
          const to = current.tabs.findIndex((tab) => tab.id === toId)
          if (from === -1 || to === -1) return current
          const [moved] = current.tabs.splice(from, 1)
          current.tabs.splice(to, 0, moved)
          return current
        })
      }, [update])

      /** Rename a sub-interface. The main tab's label is fixed. */
      const renameTab = React.useCallback((id, label) => {
        const trimmed = label.trim().slice(0, 40)
        if (trimmed === '') return
        update((current) => {
          const tab = current.tabs.find((entry) => entry.id === id)
          if (tab !== undefined && tab.kind === 'view') tab.label = trimmed
          return current
        })
      }, [update])

      /** Refresh every sub-interface's live state from the Host. */
      const refresh = React.useCallback(async () => {
        try {
          const value = await get('/list')
          const map = {}
          for (const view of value.views ?? []) map[view.id] = view
          setViews(map)
          // Whether the Host exposes the long-press-a-workspace gesture. It is
          // read rather than assumed because the Host owns the setting, and a ref
          // is used because the pointer handler below is installed once.
          workspaceWindows.current = value.config?.workspaceWindows === true
        } catch {
          /* the Host may be shutting down */
        }
      }, [])

      React.useEffect(() => {
        void refresh()
        const timer = window.setInterval(() => { void refresh() }, 4000)
        return () => { window.clearInterval(timer) }
      }, [refresh])

      // Close the tab menu on Escape or on a press anywhere outside it. Both are
      // document-level because the menu is rendered into the frame's overlay,
      // not inside a focus-trapping dialog.
      React.useEffect(() => {
        if (!menuOpen) return undefined
        const onPointerDown = (event) => {
          const target = event.target
          if (target instanceof Element && target.closest('[data-mv-own]') !== null) return
          setMenuOpen(false)
        }
        const onKeyDown = (event) => { if (event.key === 'Escape') setMenuOpen(false) }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [menuOpen])

      /**
       * Ensure a sub-interface exists and its child host is running.
       * @returns its proxied base path, or undefined on failure.
       */
      const ensureRunning = React.useCallback(async (id, options = {}) => {
        setError('')
        setBusy(true)
        try {
          // resume: the tab exists in the strip, so opening its (possibly
          // still-on-disk) profile is a REOPEN, not a fresh creation — without
          // this flag the Host's anti-reuse guard refuses and the tab would
          // never leave the "尚未运行" screen.
          if (views[id] === undefined || options.resume === true) {
            await post('/open', { id, ...(options.resume === true ? { resume: true } : {}) })
          }
          const started = await post('/start', { id })
          await refresh()
          return started.basePath ?? `/mv/${id}/`
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          return undefined
        } finally {
          setBusy(false)
        }
      }, [views, refresh])

      /**
       * Open a new sub-interface and switch to it.
       *
       * A new sub-interface starts isolated on **one** workspace, so the operator
       * is asked which one. The prompt is skipped when there is nothing to choose
       * (no registry, or a single entry), and a dismissal still creates the
       * sub-interface — refusing to create one because a picker was closed would
       * be a worse failure than starting on the default.
       *
       * The choice is carried as a `workspaceId` so the Host seeds the
       * sub-interface's registry with exactly that record; `cwd` accompanies it
       * because the Host adopts the path when the id is unknown to it.
       */
      const addView = React.useCallback(async () => {
        setError('')
        setMessage('')
        let choice
        let copyPlugins = false
        let copySessions = false
        let pluginMode = 'main'
        let cancelled = false
        try {
          const listing = await get('/workspaces')
          const workspaces = listing?.workspaces ?? []
          if (workspaces.length > 1) {
            const picked = await pickWorkspace(workspaces, '这个标签页从哪个工作区开始？')
            if (picked !== undefined) {
              choice = picked.workspace
              copyPlugins = picked.copyPlugins === true
              copySessions = picked.copySessions === true
              pluginMode = picked.pluginMode === 'own' ? 'own' : 'main'
            } else {
              // The operator dismissed the picker: cancel means cancel — no
              // view is created. (Used to fall through and create one anyway,
              // which made 取消 do nothing.)
              cancelled = true
            }
          } else if (workspaces.length === 1) choice = workspaces[0]
        } catch {
          /* the Host may be starting; fall through to a default sub-interface */
        }
        if (cancelled) {
          setMessage('已取消新建')
          return
        }

        // A NEW sub-interface is a NEW profile: the id must not collide with a
        // live tab, a closed tab, a favorite, or any profile the Host still
        // holds. Only the Host knows which profile directories exist, so the
        // id is minted there (view-N, skipping every taken one) instead of from
        // the visible tab count — which is what previously made "新建" revive
        // a closed sub-interface's leftover data.
        let id
        try {
          const minted = await post('/mint-id', {})
          id = typeof minted.id === 'string' && minted.id !== '' ? minted.id : undefined
        } catch {
          /* Host before this build: fall back to the tab-derived id */
        }
        if (id === undefined) {
          const existing = new Set(state.tabs.filter((tab) => tab.kind === 'view').map((tab) => tab.id))
          let index = existing.size + 1
          while (existing.has(`view-${String(index)}`)) index += 1
          id = `view-${String(index)}`
        }
        const index = Number(id.replace(/^view-/, '')) || undefined
        const label = choice === undefined ? `标签页 ${String(index ?? '')}` : choice.title
        update((current) => {
          // Remember the mode on the tab itself: a view in own-address mode
          // renders as an "open the window" affordance, not an embedded frame.
          current.tabs.push({ id, kind: 'view', label, pinnedTab: false, pinnedComposer: false, pluginMode })
          current.activeId = id
          return current
        })
        try {
          // Independent mode is about plugins running for real in this view, so
          // it implies copying them in even if the checkbox was missed.
          const effectiveCopyPlugins = copyPlugins || pluginMode === 'own'
          await post('/open', { id, label, workspaceId: choice.id, cwd: choice.path, copyPlugins: effectiveCopyPlugins, copySessions, pluginMode })
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
        await ensureRunning(id)
        if (copySessions && choice !== undefined) bumpReload(id)
        // Independent mode is meant to be used in a browser window at the view's
        // own address — open it as part of the same gesture.
        if (pluginMode === 'own') {
          try { await requestWindow(id) } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure))
          }
        }
      }, [state.tabs, update, ensureRunning, bumpReload])

      /** Close a sub-interface: stop its host and drop its tab. The main tab has no close control. */
      const closeView = React.useCallback(async (id) => {
        setBusy(true)
        try {
          await post('/close', { id })
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          update((current) => {
            current.tabs = current.tabs.filter((tab) => tab.id !== id)
            if (current.activeId === id) current.activeId = 'main'
            return current
          })
          void refresh()
          setBusy(false)
        }
      }, [update, refresh])

      /**
       * Close several sub-interfaces at once.
       *
       * Every child host is stopped before its tab is dropped, so a bulk close
       * leaves no orphan process behind. The main interface is never in the set:
       * it has no close control and cannot be closed from the menu either.
       */
      const closeMany = React.useCallback(async (ids) => {
        const targets = ids.filter((id) => id !== 'main')
        if (targets.length === 0) return
        setBusy(true)
        try {
          for (const id of targets) {
            try {
              await post('/close', { id })
            } catch {
              /* one failure must not strand the rest */
            }
          }
        } finally {
          update((current) => {
            current.tabs = current.tabs.filter((tab) => !targets.includes(tab.id))
            if (targets.includes(current.activeId)) current.activeId = 'main'
            return current
          })
          void refresh()
          setBusy(false)
        }
      }, [update, refresh])

      /** Tear a tab off into a real operating-system window. */
      const tearOffTab = React.useCallback(async (tab) => {
        setError('')
        setBusy(true)
        try {
          // The Host opens the window so it can give it a dedicated browser
          // profile, report it, and close it with the sub-interface. Opening it
          // from here would produce a plain browser tab instead: the shell
          // answers `window.open` by handing the URL to the OS.
          if (tab.kind !== 'main') await ensureRunning(tab.id)
          await requestWindow(tab.kind === 'main' ? 'main' : tab.id)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [ensureRunning])

      /**
       * Restart one sub-interface: stop its child host, then start it again.
       *
       * A child reads its configuration and its stores exactly once, at boot, so
       * this is what makes an isolated data clear, a newly enabled plugin, or a
       * re-mirrored model configuration take effect without restarting the whole
       * application.
       *
       * The frame is remounted afterwards by bumping `reloadKey`: the iframe
       * points at the same mount path, and a stopped-then-started host gets a new
       * port and a new cookie, so the old document would keep talking to a backend
       * that no longer exists.
       */
      const restartView = React.useCallback(async (id) => {
        setBusy(true)
        setError('')
        setMessage('')
        try {
          await post('/restart', { id })
          update((current) => current)
          bumpReload(id)
          await refresh()
          setMessage(`已重新打开 ${id}`)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [update, refresh, bumpReload])

      /**
       * Clear the sub-interface's CURRENT workspace sessions.
       *
       * The operator's semantics: 清空会话 = archive the sessions of the
       * workspace they are in, then reopen that same workspace. The Host
       * deletes only the recorded current workspace's session directory inside
       * the child's own store, restarts the child, and the restore pass lands
       * it back on that workspace with a fresh empty session. Other workspaces'
       * sessions, the list, plugins, and configuration are untouched.
       */
      const clearViewData = React.useCallback(async (id) => {
        setBusy(true)
        setError('')
        setMessage('')
        try {
          await post('/clear-data', { id })
          await post('/restart', { id })
          bumpReload(id)
          await refresh()
          setMessage(`已清空当前工作区的会话，并重新打开该工作区`)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [refresh, bumpReload])

      /**
       * Reset a sub-interface to a brand-new one: stop it, close its browser
       * windows, delete its whole profile, and drop its tab.
       *
       * This is the same operation the settings page's 重置 performs, reachable
       * from the menu where the sub-interface is being managed. Deleting the
       * profile is what makes it a real reset — installed plugins go with it — so
       * the tab must go too: a tab pointing at a deleted profile is a dead entry,
       * and an ACTIVE one covers the whole frame, composer included.
       *
       * `onGone` removes the tab from the store, which the settings page does
       * through its own `forgetTab`; here the caller supplies it because the
       * strip owns the tab list.
       */
      const resetView = React.useCallback(async (id, onGone) => {
        setBusy(true)
        setError('')
        setMessage('')
        try {
          const value = await post('/remove', { id })
          if (typeof onGone === 'function') onGone(id)
          await refresh()
          setMessage(value.removed
            ? `已重置 ${id}（解除链接 ${String(value.links)} 个）；装过的插件已随 profile 删除，需要时可再从主页同步`
            : `${id} 的 profile 本来就不存在`)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [refresh])

      /**
       * Open a second sub-interface from the same starting point.
       *
       * The copy gets the source's plugin set and configuration, but its own
       * profile and its own isolated workspaces and sessions, so the two are
       * independent from the moment it opens. The source is left alone.
       */
      const duplicateView = React.useCallback(async (id) => {
        setBusy(true)
        setError('')
        setMessage('')
        try {
          const value = await post('/duplicate', { id })
          const newId = typeof value.id === 'string' ? value.id : ''
          if (newId !== '') {
            update((current) => {
              current.tabs.push({ id: newId, kind: 'view', label: `${newId}（副本）`, pinnedTab: false, pinnedComposer: false })
              current.activeId = newId
              return current
            })
            await ensureRunning(newId)
            setMessage(`已复制为 ${newId}`)
          }
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [update, ensureRunning])

      /**
       * Run one of the three "copy from the main interface" actions.
       *
       * One helper because they share their whole shape: call, restart the frame,
       * report. What differs is the endpoint, and that `sync-sessions` needs a
       * workspace named — sessions live under a directory keyed by the workspace
       * PATH, so "copy the sessions" is only meaningful once you say which.
       */
      const syncFromMain = React.useCallback(async (kind, id) => {
        setBusy(true)
        setError('')
        setMessage('')
        try {
          if (kind === 'plugins') {
            const value = await post('/sync-plugins', { id })
            const enabledCount = Array.isArray(value.enabled) ? value.enabled.length : 0
            const activeCount = Array.isArray(value.active) ? value.active.length : 0
            setMessage(value.added > 0 || enabledCount > 0
              ? `已从主页复制插件：新声明 ${String(value.added)} 个、启用 ${String(enabledCount)} 个（该标签页现启用第三方插件 ${String(activeCount)} 个）`
              : '主页已启用的插件在这个标签页里都已启用')
            return
          }
          if (kind === 'workspaces') {
            const value = await post('/sync-workspaces', { id })
            bumpReload(id)
            setMessage(value.seeded === true
              ? `已把主页的 ${String(value.workspaces)} 个工作区复制过来`
              : `未复制：${String(value.reason ?? '没有可复制的工作区')}`)
            return
          }
          const listing = await get('/workspaces')
          const candidates = listing?.workspaces ?? []
          if (candidates.length === 0) {
            setMessage('主页没有可复制会话的工作区')
            return
          }
          const chosen = await pickWorkspace(candidates, '复制哪个工作区的会话？')
          if (chosen === undefined) {
            setMessage('已取消')
            return
          }
          const value = await post('/sync-sessions', { id, workspace: chosen.path })
          bumpReload(id)
          setMessage(value.copied > 0
            ? `已复制「${chosen.title}」的 ${String(value.copied)} 个会话${value.kept > 0 ? `（跳过已存在的 ${String(value.kept)} 个）` : ''}`
            : `没有可复制的会话：${String(value.reason ?? '该工作区在主页里还没有会话')}`)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [bumpReload])

      // --- Document-level long-press on file paths and the settings trigger ---
      //
      // Workspace file paths are rendered by the host and by other plugins, so
      // there is no slot to hook: a capture-phase listener recognises a
      // long-press on an element that carries (or displays) a path, and tears it
      // off. The same listener recognises the sidebar's settings trigger.
      React.useEffect(() => {
        /**
         * A path is absolute when it starts with a drive, a UNC share, or a
         * POSIX root. Relative-looking text is rejected, because a sidebar row
         * shows a bare file name and tearing that off would be a guess.
         */
        const PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)[^\n]{2,}$|^\/(?:Users|home|root|mnt|opt|srv|var)[\\/][^\n]{2,}$/

        /**
         * The attributes the shipped surfaces actually render an absolute path
         * into, most specific first.
         *
         * `data-files-path` is the sidebar file tree's own attribute; it is
         * separate from the element's visible text, which is only the file name.
         * `title` is the fallback: the shared `PathLabel` puts the full path
         * there, and the deliverables pane's file header does the same. A
         * `title` that is prose rather than a path is rejected by the pattern.
         */
        const PATH_ATTRIBUTES = ['data-files-path', 'data-path', 'data-file-path', 'title']

        /** The path an element stands for, or undefined. */
        const pathOf = (element) => {
          // Walk out far enough to reach the row that carries the attribute,
          // without climbing past it into an unrelated ancestor that happens to
          // hold some other path.
          let node = element
          for (let depth = 0; depth < 6 && node !== null; depth += 1) {
            for (const attribute of PATH_ATTRIBUTES) {
              const value = node.getAttribute?.(attribute)
              if (typeof value === 'string') {
                const trimmed = value.trim()
                if (PATH_PATTERN.test(trimmed)) return trimmed
              }
            }
            node = node.parentElement
          }
          const text = (element.textContent ?? '').trim()
          return PATH_PATTERN.test(text) && text.length < 512 ? text : undefined
        }

        /** The sidebar's settings trigger, if this press is on it. */
        const isSettingsTrigger = (element) => {
          const button = element.closest('button,[role="button"]')
          if (button === null) return false
          if (button.hasAttribute('data-mv-settings-trigger')) return true
          const label = (button.getAttribute('aria-label') ?? button.textContent ?? '').trim()
          // The sidebar foot's settings row: matched on its accessible name in
          // either shipped language, and only inside the sidebar column.
          if (!/^(settings|设置)$/i.test(label)) return false
          return button.closest('[class*="sidebar"],[class*="rail"],[class*="footer"]') !== null
        }

        /**
         * The workspace a press is on, if any.
         *
         * A workspace row renders `data-row-key="workspace:<uuid>"`. The uuid is
         * the only safe identity: the row shows a *title*, and titles repeat
         * (this machine has two workspaces called "skill"). The Host resolves
         * the uuid to a directory through the shared workspace registry.
         */
        const workspaceOf = (element) => {
          const row = element.closest('[data-row-key^="workspace:"]')
          if (row === null) return undefined
          const id = (row.getAttribute('data-row-key') ?? '').slice('workspace:'.length)
          if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return undefined
          // The row's own text is the workspace name; the ghost only needs a label.
          const text = (row.textContent ?? '').trim().split('\n')[0].trim()
          return { id, label: text === '' ? id : text.slice(0, 40) }
        }

        let timer = 0
        let ghostNode = null
        let target = null
        let startX = 0
        let startY = 0
        let dragging = false

        const cleanup = () => {
          if (timer !== 0) window.clearTimeout(timer)
          timer = 0
          dragging = false
          target = null
          ghostNode?.remove()
          ghostNode = null
        }

        const onPointerDown = (event) => {
          if (event.button !== 0) return
          const element = event.target instanceof Element ? event.target : null
          if (element === null) return
          // The plugin's own chrome handles its own long-presses.
          if (element.closest('[data-mv-own]') !== null) return

          const settings = isSettingsTrigger(element)
          // The workspace gesture is switched off by default while the feature is
          // shelved; the Host reports whether it is on.
          const workspace = settings || !workspaceWindows.current ? undefined : workspaceOf(element)
          const path = settings || workspace !== undefined ? undefined : pathOf(element)
          if (!settings && workspace === undefined && path === undefined) return

          startX = event.clientX
          startY = event.clientY
          target = settings
            ? { kind: 'settings', label: '设置' }
            : workspace !== undefined
              ? { kind: 'workspace', id: workspace.id, label: workspace.label }
              : { kind: 'file', path, label: path ?? '' }
          timer = window.setTimeout(() => {
            timer = 0
            const node = document.createElement('div')
            node.setAttribute('data-mv-ghost', '')
            node.className = 'mv-ghost'
            node.textContent = target.kind === 'workspace'
              ? `工作区「${target.label}」  →  松开即在独立窗口打开`
              : `${target.label.slice(0, 80)}  →  松开即在新窗口打开`
            document.body.appendChild(node)
            ghostNode = node
          }, LONG_PRESS_MS)
        }

        const onPointerMove = (event) => {
          if (target === null) return
          if (ghostNode === null) {
            if (Math.hypot(event.clientX - startX, event.clientY - startY) > 8) cleanup()
            return
          }
          dragging = true
          ghostNode.style.left = `${String(event.clientX + 12)}px`
          ghostNode.style.top = `${String(event.clientY + 12)}px`
        }

        const onPointerUp = async (event) => {
          if (target === null) return
          const current = target
          const travel = Math.hypot(event.clientX - startX, event.clientY - startY)
          const shouldOpen = ghostNode !== null && (dragging || travel >= TEAR_OFF_PX)
          cleanup()
          if (!shouldOpen) return
          try {
            if (current.kind === 'settings') {
              const value = await post('/settings-url', {})
              openWindow(value.url)
              return
            }
            if (current.kind === 'workspace') {
              // The Host resolves the row's uuid to a directory, prepares a
              // sub-interface for it with a session in that directory, and opens
              // the window at that session.
              await post('/workspace-window', { workspaceId: current.id })
              return
            }
            const value = await post('/file-url', { path: current.path })
            openWindow(value.url)
          } catch (failure) {
            window.console.error('[dsh-multiview] tear-off failed:', failure)
          }
        }

        /**
         * Keep the press ours once it is armed.
         *
         * A workspace row is `draggable="true"` for the host's own reordering, and
         * a native drag swallows the pointermove/pointerup this gesture needs. Only
         * the armed long-press is cancelled; an ordinary drag is untouched.
         */
        const onDragStart = (event) => {
          if (ghostNode === null) return
          event.preventDefault()
        }

        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('pointermove', onPointerMove, true)
        document.addEventListener('pointerup', onPointerUp, true)
        document.addEventListener('dragstart', onDragStart, true)
        document.addEventListener('pointercancel', cleanup, true)
        return () => {
          cleanup()
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('pointermove', onPointerMove, true)
          document.removeEventListener('pointerup', onPointerUp, true)
          document.removeEventListener('dragstart', onDragStart, true)
          document.removeEventListener('pointercancel', cleanup, true)
        }
      }, [])

      // --- Tab strip -------------------------------------------------------
      const Tab = ({ tab }) => {
        const view = views[tab.id]
        const isActive = tab.id === active.id
        const press = useLongPress({
          label: tab.label,
          onClick: () => {
            update((current) => { current.activeId = tab.id; return current })
            if (tab.kind === 'view' && views[tab.id]?.state !== 'running') void ensureRunning(tab.id, { resume: true })
          },
          // The main interface has no window action of its own any more: it is
          // pinned in the strip, and every entry point for opening it elsewhere
          // was removed deliberately rather than left on one gesture.
          canTearOff: tab.kind !== 'main',
          onTearOff: () => { void tearOffTab(tab) },
        })
        return h('div', {
          className: 'mv-tab',
          'data-active': String(isActive),
          'data-pinned': String(tab.pinnedTab === true),
          'data-armed': String(press.armed),
          'data-dragging': String(dragId === tab.id),
          'data-drop': String(dropId === tab.id && dragId !== '' && dragId !== tab.id),
          'data-mv-own': '',
          draggable: renaming === tab.id ? false : true,
          onPointerDown: (event) => {
            // A press that starts on one of the tab's own controls is a click on
            // that control, not a press on the tab.
            //
            // This matters for more than intent: the long-press hook re-renders
            // its owner on pointerup, and `Tab` is declared inside `MultiView`,
            // so React sees a different component type each render and remounts
            // the subtree. That remount destroys the pressed button before the
            // browser delivers its `click`, which is why the tab's ✕ used to do
            // nothing while the identical control elsewhere worked. Letting the
            // press through to the tab would reintroduce exactly that.
            if (event.target instanceof Element && event.target.closest('button') !== null) return
            press.onPointerDown(event)
          },
          onDragStart: (event) => {
            setDragId(tab.id)
            // A data payload is required for the drag to start in some engines.
            event.dataTransfer?.setData('text/plain', tab.id)
            if (event.dataTransfer !== null && event.dataTransfer !== undefined) event.dataTransfer.effectAllowed = 'move'
          },
          onDragOver: (event) => {
            if (dragId === '' || dragId === tab.id) return
            event.preventDefault()
            if (event.dataTransfer !== null && event.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'move'
            setDropId(tab.id)
          },
          onDragLeave: () => { setDropId((current) => (current === tab.id ? '' : current)) },
          onDrop: (event) => {
            event.preventDefault()
            const from = dragId
            setDragId('')
            setDropId('')
            if (from !== '' && from !== tab.id) moveTab(from, tab.id)
          },
          onDragEnd: () => { setDragId(''); setDropId('') },
          onDoubleClick: (event) => {
            // Renaming is only offered for a sub-interface; the main tab's label
            // is a fixed name for the interface itself.
            if (tab.kind !== 'view') return
            event.stopPropagation()
            setRenaming(tab.id)
          },
          title: tab.kind === 'main'
            ? '主页（不可关闭）· 已固定在标签栏'
            : `${tab.label} · 长按拖动可在新窗口打开 · 双击重命名 · 拖动可排序`,
        },
          h('span', { className: 'mv-tab-state', 'data-state': tab.kind === 'main' ? 'running' : (view?.state ?? 'stopped') }),
          renaming === tab.id
            ? h('input', {
              className: 'mv-rename',
              defaultValue: tab.label,
              autoFocus: true,
              onClick: (event) => { event.stopPropagation() },
              onPointerDown: (event) => { event.stopPropagation() },
              onBlur: (event) => { renameTab(tab.id, event.target.value); setRenaming('') },
              onKeyDown: (event) => {
                if (event.key === 'Enter') { renameTab(tab.id, event.currentTarget.value); setRenaming('') }
                if (event.key === 'Escape') setRenaming('')
              },
            })
            : h('span', { className: 'mv-tab-label' }, tab.label),
          // The main interface carries no controls at all: it is always pinned in
          // the strip, it has no window action, and it cannot be closed.
          // Sub-interface tabs keep the favorite (⭐), the window (⧉), and
          // the close (✕) controls. ⭐ favorites the sub-interface into the
          // settings page's 常用 shelf — the SAME list the settings page
          // manages — so a favorited sub-interface is offered there even after
          // its tab is closed.
          tab.kind === 'main'
            ? null
            : [
              h('button', {
                key: 'favorite',
                className: 'mv-icon',
                'data-on': String(favorites.includes(tab.id)),
                title: favorites.includes(tab.id) ? '从常用列表移除（设置 → 标签页设置）' : '收藏到常用列表（设置 → 标签页设置，关闭后也可从那里打开）',
                onClick: (event) => { event.stopPropagation(); toggleTabFavorite(tab.id) },
              }, favorites.includes(tab.id) ? '⭐' : '☆'),
              // A real operating-system window. Named for what it is: a Chromium
              // app window when one is installed, otherwise the default browser as
              // a plain tab — never an in-app window, which the desktop shell
              // cannot give a plugin.
              h('button', {
                key: 'window',
                className: 'mv-icon',
                title: '在浏览器窗口打开（无地址栏的独立窗口）',
                onClick: (event) => { event.stopPropagation(); void tearOffTab(tab) },
              }, '⧉'),
            ],
          // The main interface has no close control: closing a sub-interface
          // must never close the main interface.
          tab.kind === 'main'
            ? null
            : h('button', {
              className: 'mv-icon',
              title: `关闭 ${tab.label}（不影响主页）`,
              onClick: (event) => { event.stopPropagation(); void closeView(tab.id) },
            }, '✕'),
        )
      }

      const strip = h('div', {
        className: 'mv-strip',
        'data-hidden': String(!stripOpen),
        'data-mv-own': '',
      },
        ...state.tabs.map((tab) => h(Tab, { key: tab.id, tab })),
        h('button', {
          className: 'mv-icon',
          title: '新建标签页',
          disabled: busy,
          onClick: () => { void addView() },
        }, '＋'),
        h('span', { className: 'mv-spacer' }),
        error !== ''
          ? h('span', { className: 'mv-mono', title: error, style: { maxWidth: '40%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, error)
          : null,
      )

      // --- Sub-interface layer ---------------------------------------------
      //
      // The layer is the embedded sub-interface, and nothing else.
      //
      // It used to carry a title bar of its own with a second close control.
      // That bar is gone: the tab already names the sub-interface and already
      // carries the close control, so the bar only duplicated both and cost a
      // row of height. The main interface still has no close control anywhere.
      // A view in own-address plugin mode does not host an iframe: its plugins
      // only reach their own host half when the page's origin IS the child, so
      // the tab renders an affordance to open (or focus) its window instead.
      // The embedded mode keeps working exactly as before — both stay
      // available; the tab just decides which one is the natural surface.
      const ownMode = (active.pluginMode === 'own') || (views[active.id]?.pluginMode === 'own')
      const openOwnWindow = async () => {
        setError('')
        setBusy(true)
        try {
          await ensureRunning(active.id)
          await requestWindow(active.id)
          setMessage(`已在独立窗口打开 ${active.label}（插件在此窗口里独立运行）`)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }
      const layer = active.kind === 'view'
        ? h('div', { className: 'mv-layer', 'data-mv-own': '' },
          ownMode
            ? h('div', { className: 'mv-notice' },
              h('strong', null, `${active.label} · 插件独立运行`),
              h('span', null, '这个标签页的插件在它自己的地址上运行（登录态、播放状态等与主页完全独立）。'),
              h('span', null, views[active.id]?.ownOrigin !== undefined
                ? `独立窗口地址：${views[active.id].ownOrigin}`
                : '启动后才能取得独立窗口地址。'),
              h('button', {
                className: 'mv-button',
                disabled: busy,
                onClick: () => { void openOwnWindow() },
              }, busy ? '正在打开…' : (views[active.id]?.windows ?? 0) > 0 ? '聚焦独立窗口（已开启）' : '在独立窗口打开'),
              (views[active.id]?.windows ?? 0) > 0
                ? h('span', { className: 'mv-mono' }, '独立窗口已开启；关闭标签页时会一并关闭。')
                : null,
            )
            : views[active.id]?.state === 'running'
              ? h('iframe', {
                className: 'mv-frame',
                // Remount on restart: the mount path is stable, the process behind
                // it is not.
                key: `view-${active.id}-${String(reloadKeys[active.id] ?? 0)}`,
                title: active.label,
                // The Host proxies this mount to the sub-interface's own child
                // host, so the document inside is a genuinely separate client.
                src: views[active.id]?.basePath ?? `/mv/${active.id}/`,
                // The sub-interface is its own application; it needs scripts,
                // same-origin storage for its own client state, and forms.
                sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads',
                allow: 'clipboard-write',
              })
              : h('div', { className: 'mv-notice' },
                h('strong', null, `${active.label} 尚未运行`),
                views[active.id]?.error !== undefined && views[active.id]?.error !== ''
                  ? h('span', { className: 'mv-mono' }, views[active.id].error)
                  : h('span', null, '这个标签页是一个独立的进程，拥有自己的插件；启动后它与主页互不影响。'),
                h('button', {
                  className: 'mv-button',
                  disabled: busy,
                  onClick: () => { void ensureRunning(active.id, { resume: true }) },
                }, busy ? '正在启动…' : '启动标签页'),
              ))
        : null

      // --- Caption controls -------------------------------------------------
      //
      // The window's top band already carries the shell's own 应用/编辑 menubar,
      // which the desktop preload renders into a shadow root at `top: 0`. These
      // controls sit immediately to its right, so the tab switch and the tab
      // menu are part of the window chrome rather than floating over the client.
      //
      // The switch is deliberately OUTSIDE the strip: the strip disappears when
      // it is closed, so a control inside it could never reopen it. This one is
      // always present, which is what makes closing the strip reversible.
      const viewTabs = state.tabs.filter((tab) => tab.kind === 'view')
      const menuIds = {
        views: viewTabs.map((tab) => tab.id),
      }

      // The shell's own panel-left glyph, turned a quarter turn clockwise so
      // its divider hugs the top edge. That is the shape of the band this
      // button controls, so the switch and the strip read as the same object.
      // The artwork is the shipped `IconPanelLeftOutline`; rotating it is what
      // makes it a tab-bar glyph rather than a second sidebar glyph.
      const stripGlyph = h('svg', {
        className: 'mv-caption-glyph',
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        fill: 'none',
        'aria-hidden': 'true',
        strokeWidth: 1,
      },
        h('path', {
          d: 'M13.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z',
          stroke: 'currentColor',
        }),
        h('path', { d: 'M5.5 1.5V14.5', stroke: 'currentColor' }),
      )

      // Two controls with two jobs, deliberately not one toggle:
      //   标签      -- opens the tab menu, which is where tabs are managed
      //   the glyph -- opens and closes the strip itself
      // Keeping them apart is what makes closing the strip reversible: the
      // glyph stays in the caption band whether the strip is open or closed.
      const caption = h('div', {
        className: 'mv-caption',
        'data-mv-own': '',
        'data-standalone': String(standalone),
      },
        h('button', {
          className: 'mv-caption-btn',
          'data-on': String(menuOpen),
          title: '标签选项',
          'aria-haspopup': 'menu',
          'aria-expanded': String(menuOpen),
          onClick: () => { setMenuOpen((value) => !value) },
        }, '标签', h('span', { className: 'mv-caption-count' }, String(state.tabs.length))),
        h('button', {
          className: 'mv-caption-btn',
          'data-icon': 'true',
          'data-on': String(stripOpen),
          title: stripOpen ? '关闭标签栏' : '打开标签栏',
          'aria-pressed': String(stripOpen),
          'aria-label': stripOpen ? '关闭标签栏' : '打开标签栏',
          onClick: () => { setStripOpen(!stripOpen) },
        }, stripGlyph),
      )

      const menu = menuOpen
        ? h('div', {
          className: 'mv-menu',
          'data-mv-own': '',
          role: 'menu',
          // A press inside the menu must not reach the document-level long-press
          // listener, which would otherwise arm a tear-off behind the popup.
          onPointerDown: (event) => { event.stopPropagation() },
        },
          h('div', { className: 'mv-menu-hint' }, '标签'),
          h('button', {
            className: 'mv-menu-item',
            role: 'menuitem',
            disabled: busy,
            onClick: () => { setMenuOpen(false); void addView() },
          }, '＋  新建标签页'),
          h('div', { className: 'mv-menu-sep' }),
          h('div', { className: 'mv-menu-hint' }, `关闭（${String(viewTabs.length)} 个标签页）`),
          h('button', {
            className: 'mv-menu-item',
            'data-danger': 'true',
            role: 'menuitem',
            disabled: busy || menuIds.views.length === 0,
            onClick: () => { setMenuOpen(false); void closeMany(menuIds.views) },
          }, '关闭全部标签页'),
          h('div', { className: 'mv-menu-sep' }),
          h('div', { className: 'mv-menu-hint' }, `标签页管理（${String(viewTabs.length)} 个）`),
          // Each sub-interface gets its own row of actions. They are grouped per
          // tab rather than offered as one bulk action because every one of them
          // is destructive or disruptive, and "which sub-interface" is the whole
          // question the operator is asking at this point.
          viewTabs.length === 0
            ? h('button', { className: 'mv-menu-item', role: 'menuitem', disabled: true }, '还没有标签页')
            : h('div', { className: 'mv-manage' }, ...viewTabs.map((tab) => {
              const view = views[tab.id]
              const running = view?.state === 'running'
              const isActive = tab.id === state.activeId
              return h('div', { key: tab.id, className: 'mv-manage-row' },
                h('span', {
                  className: 'mv-manage-name',
                  title: `${tab.label} · ${tab.id}${running ? ' · 运行中' : ` · ${view?.state ?? '未加载'}`}`,
                }, tab.label),
                h('button', {
                  className: 'mv-manage-btn',
                  disabled: busy,
                  title: isActive
                    ? '停止再启动它，让它重新读取配置与数据'
                    : `重新打开 ${tab.label}，并切换到它`,
                  onClick: () => {
                    setMenuOpen(false)
                    update((current) => { current.activeId = tab.id; return current })
                    void restartView(tab.id)
                  },
                }, '重新打开'),
                h('button', {
                  className: 'mv-manage-btn',
                  disabled: busy,
                  title: `复制 ${tab.label}：沿用它的插件与配置，但拥有自己的 profile 与独立工作区、会话`,
                  onClick: () => { setMenuOpen(false); void duplicateView(tab.id) },
                }, '复制打开'),
                h('button', {
                  className: 'mv-manage-btn',
                  disabled: busy,
                  title: `在独立浏览器窗口打开 ${tab.label}（无地址栏）`,
                  onClick: () => { setMenuOpen(false); void tearOffTab(tab) },
                }, '浏览器打开'),
                h('button', {
                  className: 'mv-manage-btn',
                  'data-danger': 'true',
                  disabled: busy,
                  title: `清空 ${tab.label} 的会话（它的插件与工作区列表保留）`,
                  onClick: () => {
                    setMenuOpen(false)
                    void confirmDialog(`清空「${tab.label}」的会话？`, [
                      '只清当前工作区的会话；其他工作区与插件不动。',
                      '它装过的插件与其余配置保留。',
                      '主页的数据不受影响。',
                    ]).then((confirmed) => { if (confirmed) void clearViewData(tab.id) })
                  },
                }, '清空会话'),
                h('button', {
                  className: 'mv-manage-btn',
                  'data-danger': 'true',
                  disabled: busy,
                  title: `重置 ${tab.label}：删除整个 profile，回到全新状态（装过的插件一起删除）`,
                  onClick: () => {
                    setMenuOpen(false)
                    void confirmDialog(`重置「${tab.label}」？`, [
                      '将停止它、关掉它的浏览器窗口，并删除整个 profile。',
                      '它装过的插件会一起删除（之后可用「插件」按钮从主页重新同步）。',
                      '它的工作区与会话全部清空。',
                      '主页的数据不受影响。',
                    ]).then((confirmed) => {
                      if (!confirmed) return
                      void resetView(tab.id, (gone) => {
                        update((current) => {
                          current.tabs = current.tabs.filter((tab) => tab.id !== gone)
                          if (current.activeId === gone) current.activeId = 'main'
                          return current
                        })
                      })
                    })
                  },
                }, '重置'),
                h('button', {
                  className: 'mv-manage-btn',
                  'data-danger': 'true',
                  disabled: busy,
                  title: `关闭 ${tab.label}（保留它的 profile，标签消失但数据还在）`,
                  onClick: () => {
                    setMenuOpen(false)
                    void closeView(tab.id)
                  },
                }, '关闭'),
              )
            })),
          message === ''
            ? null
            : h('div', { className: 'mv-menu-hint', role: 'status' }, message),
          error === ''
            ? null
            : h('div', { className: 'mv-menu-hint', 'data-error': 'true', role: 'alert' }, error),
          h('div', { className: 'mv-menu-sep' }),
          h('div', { className: 'mv-menu-hint' }, `从主页复制（${String(viewTabs.length)} 个标签页）`),
          // Three explicit copy actions, one row per sub-interface, because each
          // one pulls a different kind of state across the isolation boundary and
          // the operator wants them separately: plugins, the workspace list, and
          // the conversations for a chosen workspace.
          viewTabs.length === 0
            ? h('button', { className: 'mv-menu-item', role: 'menuitem', disabled: true }, '还没有标签页')
            : h('div', { className: 'mv-manage' }, ...viewTabs.map((tab) => h('div', { key: `sync-${tab.id}`, className: 'mv-manage-row' },
              h('span', { className: 'mv-manage-name', title: `${tab.label} · ${tab.id}` }, `⇄ ${tab.label}`),
              h('button', {
                className: 'mv-manage-btn',
                disabled: busy,
                title: '把主页已安装的第三方插件复制过来，并启用主页当前已启用的那些（复制后自动重启该标签页使其加载；之后互不影响）',
                onClick: () => { setMenuOpen(false); void syncFromMain('plugins', tab.id) },
              }, '插件'),
              h('button', {
                className: 'mv-manage-btn',
                disabled: busy,
                title: '用主页的工作区列表替换该标签页的列表（会话不复制，另有单独按钮）',
                onClick: () => {
                  setMenuOpen(false)
                  void confirmDialog(`用主页的工作区列表替换「${tab.label}」的列表？`, [
                    '这个标签页自己新增或删除过的工作区记录会被覆盖。',
                    '会话不会被复制（用「会话」按钮单独复制）。',
                    '它装过的插件不受影响。',
                  ]).then((confirmed) => { if (confirmed) void syncFromMain('workspaces', tab.id) })
                },
              }, '工作区'),
              h('button', {
                className: 'mv-manage-btn',
                disabled: busy,
                title: '选择主页的一个工作区，把它的会话复制到这个标签页（已存在的会话不会覆盖）',
                onClick: () => { setMenuOpen(false); void syncFromMain('sessions', tab.id) },
              }, '会话'),
            ))),
        )
        : null

      return h(React.Fragment, null, caption, menu, strip, layer)
    }

    // -----------------------------------------------------------------------
    // In-page confirmation dialog
    // -----------------------------------------------------------------------

    /**
     * Ask for confirmation with an in-page dialog, never `window.confirm`.
     *
     * The native dialog is why "清空会话 / 重置 / 替换列表 froze my typing": on
     * Electron, after a native confirm() the window's keyboard input can stay
     * dead until the window loses and regains focus (the tray-icon click
     * users discovered as the workaround). An in-page dialog is just DOM — it
     * cannot wedge the input stack — and its buttons put focus back where the
     * pointer already is.
     *
     * Resolves with true (确认) or false (取消). Settled exactly once,
     * including Escape and a backdrop click.
     *
     * @param heading - the dialog's title line.
     * @param lines - body lines, shown as separate paragraphs.
     * @param confirmLabel - the confirm button's text.
     * @returns whether the operator confirmed.
     */
    function confirmDialog(heading, lines, confirmLabel = '确认') {
      return new Promise((resolve) => {
        const host = document.createElement('div')
        host.setAttribute('data-mv-own', '')
        host.style.cssText = 'position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;'
          + 'background:rgba(0,0,0,.45);font:13px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif;'

        let settled = false
        const finish = (value) => {
          if (settled) return
          settled = true
          window.removeEventListener('keydown', onKey, true)
          host.remove()
          resolve(value)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') { event.stopPropagation(); finish(false) }
        }

        const panel = document.createElement('div')
        // Same surface material as the app's own menus: theme-owned
        // translucent fill + official blur, following the light/dark choice.
        panel.style.cssText = 'width:min(460px,92vw);border-radius:10px;'
          + 'background:var(--dsw-specific-menu,var(--dsw-menu-surface-fill,#26272f));'
          + 'backdrop-filter:var(--dsw-menu-backdrop-filter,none);border:0;'
          + 'box-shadow:var(--dsw-elevation-panel,0 24px 64px rgba(0,0,0,.5));'
          + 'color:var(--dsw-alias-label-primary,#f9fafb);overflow:hidden'

        const title = document.createElement('div')
        title.textContent = heading
        title.style.cssText = 'padding:12px 16px;font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l1,#2c2d36)'
        panel.append(title)

        const body = document.createElement('div')
        body.style.cssText = 'padding:12px 16px;display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-secondary,#9aa1ad);white-space:pre-line'
        for (const line of lines) {
          const paragraph = document.createElement('div')
          paragraph.textContent = line
          body.append(paragraph)
        }
        panel.append(body)

        const footer = document.createElement('div')
        footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l1,#2c2d36)'
        const cancel = document.createElement('button')
        cancel.type = 'button'
        cancel.textContent = '取消'
        cancel.style.cssText = 'height:28px;padding:0 14px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#2c2d36);'
          + 'background:transparent;color:inherit;font:inherit;cursor:pointer'
        cancel.onclick = () => { finish(false) }
        const ok = document.createElement('button')
        ok.type = 'button'
        ok.textContent = confirmLabel
        ok.style.cssText = 'height:28px;padding:0 14px;border-radius:6px;border:0;'
          + 'background:var(--dsw-alias-state-error-primary,#ef4444);color:#fff;font:inherit;cursor:pointer'
        ok.onclick = () => { finish(true) }
        footer.append(cancel, ok)
        panel.append(footer)

        host.append(panel)
        host.onclick = (event) => { if (event.target === host) finish(false) }
        window.addEventListener('keydown', onKey, true)
        document.body.append(host)
        // Land keyboard focus on the safe button so Enter cancels, not confirms.
        cancel.focus()
      })
    }

    // -----------------------------------------------------------------------
    // Choosing a starting workspace
    // -----------------------------------------------------------------------

    /**
     * Ask the operator to pick one of the main interface's workspaces.
     *
     * A plain in-page dialog rather than `window.prompt`: the list can be long,
     * each entry needs its full path shown (titles repeat on this machine — there
     * are two called "skill"), and a native prompt cannot render either.
     *
     * Below the list sit two checkboxes — 复制插件 and 复制会话 — because this is
     * the one moment the operator is already deciding what the new sub-interface
     * starts with. Checking 复制插件 copies the main interface's third-party
     * plugins in and ENABLES the ones the main interface has enabled; checking
     * 复制会话 copies the chosen workspace's conversations into the new
     * sub-interface. Both default to off: a plain, isolated new sub-interface is
     * still what creation means, and a copy is an explicit choice.
     *
     * Under them sits the plugin-RUNNING-MODE radio: 依托主页 (the default,
     * the 0.1 behaviour) or 插件独立运行 (own address). The mode decides how the
     * view's plugins reach their host half — through the main interface's
     * origin (fine for official plugins) or in a browser window opened at this
     * view's own address, where front/back-half plugins like the music panel
     * actually work. Choosing 独立 turns the tab into an "open the window"
     * affordance rather than an embedded frame.
     *
     * Resolves with `{ workspace, copyPlugins, copySessions, pluginMode }`, or
     * `undefined` when dismissed. The promise is settled exactly once,
     * including when the dialog is closed by Escape or by a click on the
     * backdrop.
     *
     * @param workspaces - `[{ id, title, path }]`, already in display order.
     * @param title - the dialog's heading.
     * @returns the choice with the copy flags and the plugin mode, or undefined.
     */
    function pickWorkspace(workspaces, title) {
      return new Promise((resolve) => {
        const host = document.createElement('div')
        host.setAttribute('data-mv-own', '')
        host.style.cssText = 'position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;'
          + 'background:rgba(0,0,0,.45);font:13px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif;'

        let settled = false
        let copyPlugins = false
        let copySessions = false
        let pluginMode = 'main'
        const finish = (value) => {
          if (settled) return
          settled = true
          window.removeEventListener('keydown', onKey, true)
          host.remove()
          resolve(value)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') { event.stopPropagation(); finish(undefined) }
        }

        const panel = document.createElement('div')
        // Same official menu material as above (theme-following, blurred).
        panel.style.cssText = 'width:min(620px,92vw);max-height:76vh;display:flex;flex-direction:column;border-radius:10px;'
          + 'background:var(--dsw-specific-menu,var(--dsw-menu-surface-fill,#26272f));'
          + 'backdrop-filter:var(--dsw-menu-backdrop-filter,none);border:0;'
          + 'box-shadow:var(--dsw-elevation-panel,0 24px 64px rgba(0,0,0,.5));'
          + 'color:var(--dsw-alias-label-primary,#f9fafb);overflow:hidden'

        const heading = document.createElement('div')
        heading.textContent = title
        heading.style.cssText = 'padding:12px 14px;font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l1,#2c2d36)'
        panel.append(heading)

        const list = document.createElement('div')
        list.style.cssText = 'overflow:auto;padding:6px'
        if (workspaces.length === 0) {
          const empty = document.createElement('div')
          empty.textContent = '主页还没有工作区'
          empty.style.cssText = 'padding:14px;color:var(--dsw-alias-label-secondary,#9aa1ad)'
          list.append(empty)
        }
        for (const workspace of workspaces) {
          const row = document.createElement('button')
          row.type = 'button'
          row.style.cssText = 'display:block;width:100%;text-align:left;padding:8px 10px;border:0;border-radius:6px;'
            + 'background:transparent;color:inherit;font:inherit;cursor:pointer'
          row.onmouseenter = () => { row.style.background = 'var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,#22232b))' }
          row.onmouseleave = () => { row.style.background = 'transparent' }
          const name = document.createElement('div')
          name.textContent = workspace.title
          name.style.cssText = 'font-weight:500'
          const pathLine = document.createElement('div')
          pathLine.textContent = workspace.path
          pathLine.style.cssText = 'color:var(--dsw-alias-label-secondary,#9aa1ad);font-size:11px;'
            + 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
          row.append(name, pathLine)
          row.onclick = () => { finish({ workspace, copyPlugins, copySessions, pluginMode }) }
          list.append(row)
        }
        panel.append(list)

        // The two creation-time copies. Native checkboxes styled by hand: the
        // dialog ships no React here, and a label wrapping its input keeps the
        // whole row clickable without id wiring.
        const options = document.createElement('div')
        options.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:10px 14px;'
          + 'border-top:1px solid var(--dsw-alias-border-l1,#2c2d36);color:var(--dsw-alias-label-secondary,#9aa1ad);font-size:12px'
        const makeOption = (label, checked, onToggle) => {
          const row = document.createElement('label')
          row.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;white-space:nowrap'
          const box = document.createElement('input')
          box.type = 'checkbox'
          box.checked = checked
          box.style.cssText = 'width:13px;height:13px;accent-color:var(--dsw-alias-brand-primary,#247bbf);cursor:pointer'
          box.onchange = () => { onToggle(box.checked) }
          const text = document.createElement('span')
          text.textContent = label
          row.append(box, text)
          return row
        }
        options.append(
          makeOption('复制主页插件（已启用的第三方插件会被复制并启用）', false, (value) => { copyPlugins = value }),
          makeOption('复制所选工作区的会话到这个标签页', false, (value) => { copySessions = value }),
        )
        panel.append(options)

        // The plugin running mode. A radio pair rather than a checkbox: the two
        // modes are exclusive readings of "where do this view's plugins run",
        // not two independent toggles.
        const modeGroup = document.createElement('div')
        modeGroup.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:10px 14px;'
          + 'border-top:1px solid var(--dsw-alias-border-l1,#2c2d36);color:var(--dsw-alias-label-secondary,#9aa1ad);font-size:12px'
        const modeTitle = document.createElement('div')
        modeTitle.textContent = '插件运行方式'
        modeTitle.style.cssText = 'font-weight:600;color:var(--dsw-alias-label-primary,#f9fafb)'
        modeGroup.append(modeTitle)
        const makeRadio = (value, label, hint, checked) => {
          const row = document.createElement('label')
          row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;cursor:pointer'
          const dot = document.createElement('input')
          dot.type = 'radio'
          dot.name = 'mv-plugin-mode'
          dot.value = value
          dot.checked = checked
          dot.style.cssText = 'width:13px;height:13px;margin-top:2px;accent-color:var(--dsw-alias-brand-primary,#247bbf);cursor:pointer'
          dot.onchange = () => { if (dot.checked) pluginMode = value }
          const text = document.createElement('span')
          const line = document.createElement('div')
          line.textContent = label
          line.style.cssText = 'color:var(--dsw-alias-label-primary,#f9fafb)'
          const note = document.createElement('div')
          note.textContent = hint
          note.style.cssText = 'font-size:11px'
          text.append(line, note)
          row.append(dot, text)
          return row
        }
        modeGroup.append(
          makeRadio('main', '依托主页', '第三方插件的运行数据与主页共用；适合官方插件与轻量使用', true),
          makeRadio('own', '插件独立运行（独立窗口）', '复制插件，并在独立窗口打开这个标签页：插件在自己的地址上运行，登录态、播放状态等完全独立', false),
        )
        panel.append(modeGroup)

        const footer = document.createElement('div')
        footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1,#2c2d36)'
        const cancel = document.createElement('button')
        cancel.type = 'button'
        cancel.textContent = '取消'
        cancel.style.cssText = 'height:28px;padding:0 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#2c2d36);'
          + 'background:transparent;color:inherit;font:inherit;cursor:pointer'
        cancel.onclick = () => { finish(undefined) }
        footer.append(cancel)
        panel.append(footer)

        host.append(panel)
        host.onclick = (event) => { if (event.target === host) finish(undefined) }
        window.addEventListener('keydown', onKey, true)
        document.body.append(host)
      })
    }

    // -----------------------------------------------------------------------
    // Pinned chips below the composer
    // -----------------------------------------------------------------------

    /**
     * The pinned sub-interface chips shown below the main interface's
     * new-conversation input. Clicking one activates that sub-interface.
     */
    function PinnedChips(props) {
      const { store } = props
      const [state, setState] = React.useState(store.get())
      React.useEffect(() => store.subscribe(setState), [store])
      const [failure, setFailure] = React.useState('')
      const pinned = state.tabs.filter((tab) => tab.pinnedComposer === true)
      if (pinned.length === 0) return null

      /**
       * Open one pinned target in an operating-system window.
       *
       * A pinned chip may point at a sub-interface that is stopped (pinning
       * survives a restart), so a refused first attempt starts it and retries
       * once rather than surfacing a "not running" error for a click that was
       * obviously meant to open something.
       */
      const openInWindow = async (tab) => {
        setFailure('')
        try {
          if (tab.kind === 'main') {
            await requestWindow('main')
            return
          }
          try {
            await requestWindow(tab.id)
          } catch {
            // The chip's target may simply be closed; reopen with its data.
            await post('/open', { id: tab.id, resume: true })
            await post('/start', { id: tab.id })
            await requestWindow(tab.id)
          }
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        }
      }

      return h('div', { className: 'mv-dock', 'data-mv-own': '' },
        ...pinned.flatMap((tab) => [
          h('button', {
            key: tab.id,
            className: 'mv-chip',
            title: `${tab.label} · 点击直达`,
            onClick: () => { store.activate(tab.id) },
          }, '▣ ', tab.label),
          h('button', {
            key: `${tab.id}:window`,
            className: 'mv-chip mv-chip-window',
            title: `${tab.label} · 在浏览器窗口打开（无地址栏的独立窗口）`,
            onClick: () => { void openInWindow(tab) },
          }, '⧉'),
        ]),
        failure === '' ? null : h('span', { className: 'mv-dock-error' }, failure),
      )
    }

    // -----------------------------------------------------------------------
    // Settings section
    // -----------------------------------------------------------------------

    /**
     * This plugin's own settings page, describing what it does and its state.
     *
     * It receives the shared tab `store` for one reason: "reset" deletes the
     * sub-interface's profile, and the tab for it is held in that store. A reset
     * that left the tab in place pointed the UI at a profile that no longer
     * existed, and if that tab was the active one the whole frame stayed covered
     * by this plugin's own layer — including the composer.
     */
    function SettingsSection(props) {
      const { store } = props
      useStyles()
      const [views, setViews] = React.useState([])
      const [state, setState] = React.useState(store.get())
      const [models, setModels] = React.useState(undefined)
      const [message, setMessage] = React.useState('')
      /** Shared favorite list (Host-persisted; same list in every window). */
      const [favorites, setFavorites] = React.useState([])
      /** True while an open/reset request is in flight; disables the row buttons. */
      const [busy, setBusy] = React.useState(false)
      /** Closed-but-unreset profiles, refreshed with /list. */
      const [closedProfiles, setClosedProfiles] = React.useState([])

      /** Remove a reset entry from favorites so the shelf stays accurate. */
      const toggleFavoriteIfPresent = React.useCallback(async (id) => {
        try {
          const current = await fetchFavorites()
          if (current.includes(id)) setFavorites(await toggleFavoriteOnHost(id))
        } catch { /* best effort */ }
      }, [])

      React.useEffect(() => store.subscribe(setState), [store])

      const toggleFavorite = React.useCallback(async (id) => {
        try {
          setFavorites(await toggleFavoriteOnHost(id))
        } catch (error) {
          setMessage(error instanceof Error ? error.message : String(error))
        }
      }, [])

      /**
       * Drop a sub-interface's tab after its profile has been deleted.
       *
       * The tab is persisted in localStorage and nothing else prunes it, so
       * without this the tab outlives the thing it points at. The main tab is
       * never a target. `pinnedComposer`/`pinnedTab` go with the tab itself, so
       * the pinned chips stop offering a target that no longer resolves.
       */
      const forgetTab = React.useCallback((id) => {
        const current = store.get()
        const tabs = current.tabs.filter((tab) => tab.id !== id)
        if (tabs.length === current.tabs.length) return
        store.set({
          tabs,
          // Always land on the main interface: the tab that was removed is the
          // one this page just deleted, so it cannot stay active.
          activeId: current.activeId === id ? 'main' : current.activeId,
          stripOpen: current.stripOpen !== false,
        })
      }, [store])
      React.useEffect(() => {
        let live = true
        const load = async () => {
          try {
            const value = await get('/list')
            if (live) setViews(value.views ?? [])
          } catch { /* Host not reachable yet */ }
          try {
            const value = await get('/closed-profiles')
            if (live) setClosedProfiles(value.profiles ?? [])
          } catch { /* Host before this build: no closed list */ }
          try {
            const value = await get('/model-config')
            if (live) setModels(value)
          } catch { /* ignore */ }
          // The shared favorite list — refresh with the same cadence, so a
          // toggle made in another window (e.g. an independent one) shows up.
          setFavorites(await fetchFavorites())
        }
        void load()
        const timer = window.setInterval(() => { void load() }, 5000)
        return () => { live = false; window.clearInterval(timer) }
      }, [])

      return h('div', { className: 'mv-settings' },
        h('h3', null, '标签页 MultiView'),
        h('p', null, '每个标签页都是一个独立的进程，有自己独立的插件与数据目录；因此它安装的插件不影响主页，各标签页之间也可以互不相同。'),
        h('div', { className: 'mv-row' },
          h('span', null, '运行中的标签页'),
          h('span', null, String(views.filter((view) => view.state === 'running').length)),
        ),
        h('div', { className: 'mv-row' },
          h('span', null, '主页模型配置'),
          h('span', { className: 'mv-mono' }, models === undefined ? '读取中…' : (models.rows ?? []).join(', ') || '未找到'),
        ),
        h('div', { className: 'mv-row' },
          h('button', {
            className: 'mv-button',
            onClick: async () => {
              try {
                const value = await post('/sync-models', {})
                setMessage(`已同步到 ${String((value.synced ?? []).length)} 个标签页`)
              } catch (error) {
                setMessage(error instanceof Error ? error.message : String(error))
              }
            },
          }, '立即同步模型配置'),
        ),
        message === '' ? null : h('p', { className: 'mv-mono' }, message),
        // --- 标签页设置（常用收藏） ------------------------------------------
        // The operator's shortcut shelf. Each entry remembers which plugin
        // running mode it was opened with (依托主页 / 独立运行), so a
        // reopened favorite comes back the way it was. Favorites are ALSO
        // offered for closed profiles in the section below.
        h('h3', null, '标签页设置（常用收藏）'),
        h('p', null, '常用的标签页收藏在这里，每条会标注它的插件运行方式（⌂ 依托主页 / ⬒ 独立运行）。点「打开」恢复；点「移除」只是不再收藏。'),
        (() => {
          if (favorites.length === 0) {
            return h('p', null, '还没有收藏。在下面的「已打开的标签页」里点「收藏」，或给标签页标签点 ☆。')
          }
          const modeBadge = (mode) => mode === 'own' ? '⬒ 独立' : '⌂ 依托主页'
          return h('div', null, ...favorites.map((id) => {
            const view = views.find((entry) => entry.id === id)
            const mode = view?.pluginMode ?? closedProfiles.find((entry) => entry.id === id)?.pluginMode
            return h('div', { key: id, className: 'mv-row' },
              h('span', null, id),
              h('span', { className: 'mv-mono' }, `${mode === undefined ? '' : `${modeBadge(mode)} · `}${view === undefined
                ? '已关闭 · 数据保留'
                : `${view.state}${view.windows ? ` · 浏览器窗口 ${String(view.windows)}` : ''}`}`),
              h('span', { style: { display: 'flex', gap: '8px' } },
                h('button', {
                  className: 'mv-button',
                  disabled: busy,
                  title: '启动它并在标签栏里打开（数据保留，回到上次的工作区）',
                  onClick: async () => {
                    setBusy(true)
                    try {
                      // resume: true — reopening a closed sub-interface with its
                      // data intact is exactly the point here. (Without it the
                      // Host refuses /open for an existing profile.)
                      await post('/open', { id, resume: true })
                      await post('/start', { id })
                      const current = store.get()
                      if (!current.tabs.some((tab) => tab.id === id)) {
                        store.set({
                          tabs: [...current.tabs, { id, kind: 'view', label: id, pinnedTab: false, pinnedComposer: false, pluginMode: mode }],
                          activeId: id,
                          stripOpen: current.stripOpen !== false,
                        })
                      } else {
                        store.activate(id)
                      }
                      setMessage(`已打开 ${id}`)
                    } catch (error) {
                      setMessage(error instanceof Error ? error.message : String(error))
                    } finally {
                      setBusy(false)
                    }
                  },
                }, '打开'),
                h('button', {
                  className: 'mv-button',
                  title: '不再收藏（标签页本身与它的数据不受影响）',
                  onClick: () => { toggleFavorite(id) },
                }, '移除'),
              ),
            )
          }))
        })(),
        // --- 已关闭的标签页 ---------------------------------------------------
        // Closed (✕) but un-reset sub-interfaces: data still on disk. This is
        // the ONLY place a closed one can be reopened or reset — 新建 never
        // revives them.
        h('h3', null, '已关闭的标签页'),
        h('p', null, '关闭（✕）不删除：它们的插件、会话与配置都留在本地。这里可以重新打开或彻底重置；「新建标签页」永远不会复用它们的数据。'),
        (() => {
          const closed = closedProfiles.filter((entry) => !favorites.includes(entry.id))
          if (closed.length === 0) {
            return h('p', null, '没有已关闭的标签页（或都已收藏在上方）。')
          }
          const modeBadge = (mode) => mode === 'own' ? '⬒ 独立' : '⌂ 依托主页'
          return h('div', null, ...closed.map((entry) => h('div', { key: entry.id, className: 'mv-row' },
            h('span', null, entry.id),
            h('span', { className: 'mv-mono' }, `已关闭 · 数据保留${entry.pluginMode === undefined ? '' : ` · ${modeBadge(entry.pluginMode)}`}`),
            h('span', { style: { display: 'flex', gap: '8px' } },
              h('button', {
                className: 'mv-button',
                disabled: busy,
                title: '启动它并在标签栏里打开（数据保留，回到上次的工作区）',
                onClick: async () => {
                  setBusy(true)
                  try {
                    await post('/open', { id: entry.id, resume: true })
                    await post('/start', { id: entry.id })
                    const current = store.get()
                    if (!current.tabs.some((tab) => tab.id === entry.id)) {
                      store.set({
                        tabs: [...current.tabs, { id: entry.id, kind: 'view', label: entry.id, pinnedTab: false, pinnedComposer: false, pluginMode: entry.pluginMode }],
                        activeId: entry.id,
                        stripOpen: current.stripOpen !== false,
                      })
                    } else {
                      store.activate(entry.id)
                    }
                    setMessage(`已打开 ${entry.id}`)
                  } catch (error) {
                    setMessage(error instanceof Error ? error.message : String(error))
                  } finally {
                    setBusy(false)
                  }
                },
              }, '打开'),
              h('button', {
                className: 'mv-button',
                title: '收藏到常用列表',
                onClick: () => { toggleFavorite(entry.id) },
              }, '收藏'),
              h('button', {
                className: 'mv-button',
                title: '彻底删除：整个 profile 连同插件、会话一起清掉（页面内确认）',
                onClick: async () => {
                  const confirmed = await confirmDialog(`重置已关闭的「${entry.id}」？`, [
                    '将删除它的整个 profile（插件、会话、配置全部清空，不可恢复）。',
                    entry.profile,
                  ], '重置')
                  if (!confirmed) return
                  setBusy(true)
                  try {
                    const value = await post('/remove', { id: entry.id })
                    toggleFavoriteIfPresent(entry.id)
                    setMessage(value.removed
                      ? `已重置 ${entry.id}（解除链接 ${String(value.links)} 个）`
                      : `${entry.id} 的 profile 本来就不存在`)
                  } catch (error) {
                    setMessage(error instanceof Error ? error.message : String(error))
                  } finally {
                    setBusy(false)
                  }
                },
              }, '重置'),
            ),
          )))
        })(),
        h('h3', null, '已打开的标签页'),
        h('p', null, '删除标签页请用这里的「重置」：它会先解除该 profile 里的链接，再删目录。'
          + '直接手动删数据目录会顺着链接把主页安装的插件一起删掉 —— 这一点已经踩过两次。'),
        views.length === 0
          ? h('p', null, '还没有标签页。用标签栏上的 ＋ 新建一个。')
          : h('div', null, ...views.map((view) => h('div', { key: view.id, className: 'mv-row' },
            h('span', null, view.id),
            h('span', { className: 'mv-mono' }, `${view.state} · ${view.profile}${view.windows === undefined || view.windows === 0 ? '' : ` · 浏览器窗口 ${String(view.windows)}`}`),
            h('span', { style: { display: 'flex', gap: '8px' } },
              h('button', {
                className: 'mv-button',
                title: favorites.includes(view.id) ? '从常用列表移除' : '加入常用列表（关闭后也可从这里打开）',
                onClick: () => { toggleFavorite(view.id) },
              }, favorites.includes(view.id) ? '取消收藏' : '收藏'),
              h('button', {
                className: 'mv-button',
                title: '停止它并删除它的 profile 目录（装过的插件、该 profile 的配置都在里面）',
                onClick: async () => {
                  const confirmed = await confirmDialog(`重置「${view.id}」？`, [
                    '将停止它、关掉它的浏览器窗口，并删除 profile：',
                    view.profile,
                    '该标签页里装过的插件会一起消失。',
                  ])
                  if (!confirmed) return
                  try {
                    const value = await post('/remove', { id: view.id })
                    // The profile is gone, so its tab must go too. Leaving it would
                    // point the UI at something that does not exist — and an active
                    // dead tab covers the whole frame, composer included.
                    forgetTab(view.id)
                    setMessage(value.removed
                      ? `已重置 ${view.id}（解除链接 ${String(value.links)} 个）`
                      : `${view.id} 的 profile 本来就不存在`)
                  } catch (error) {
                    setMessage(error instanceof Error ? error.message : String(error))
                  }
                },
              }, '重置'),
            ))),
      ),
    )
  }


    // -----------------------------------------------------------------------
    // Plugin body
    // -----------------------------------------------------------------------

    /** Services the client half needs; `slots` is the only hard requirement. */
    const inject = ['slots']

    /**
     * Client plugin body.
     * @param ctx - the client cordis context.
     */
    function apply(ctx) {
      // One store instance per activation, shared by the strip, the pinned
      // chips, and the settings page, so a click anywhere stays consistent.
      // Created here rather than at module scope, per the framework's
      // one-instance-per-activation rule for plugin-owned state.
      const listeners = new Set()
      let current = loadState()
      const store = {
        get: () => current,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set(next) {
          current = next
          saveState(current)
          for (const listener of [...listeners]) listener(current)
        },
        activate(id) {
          store.set({ tabs: current.tabs, activeId: id, stripOpen: current.stripOpen !== false })
        },
      }

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'multiview-strip',
        order: 10,
        label: () => '标签页标签栏',
        inject: () => ({ store }),
      }, MultiView))

      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'multiview-pinned',
        order: 20,
        label: () => '固定的标签页',
        inject: () => ({ store }),
      }, PinnedChips))

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'multiview',
        order: 120,
        label: () => '标签页 MultiView',
        // The settings page performs "reset", which deletes a sub-interface's
        // profile. Its tab lives in this store, so the store has to reach the page:
        // without it a reset left the tab behind, pointing at a profile that no
        // longer exists (see the reset handler).
        inject: () => ({ store }),
      }, SettingsSection))
    }

    return { name: 'dsh-multiview', inject, apply }
  },
})
