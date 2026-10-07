/**
 * dsh-multiview — Host half.
 *
 * Owns the "sub-interface" (分界面) lifecycle for the whole app.
 *
 * ## Isolation
 *
 * Each sub-interface is a **complete, separate `dsh` Host process** booted with
 * its own profile directory (`$DSH_HOME/profiles/dsh-multiview-<viewId>`). That
 * makes "plugins installed in one sub-interface never affect the main
 * interface" literally true rather than emulated: a child profile carries its
 * own `package.json`, its own `node_modules`, its own `cordis.patch.yml`, and
 * its own `dsh.profile.bundles` list. Two sub-interfaces may install the same
 * plugin, different plugins, or conflicting versions of one plugin and never
 * meet — they are separate processes reading separate directories.
 *
 * ## Reachability
 *
 * The desktop shell's renderer can only reach its own origin (`dsh-app://app`,
 * served by the main Host), and it hands http(s) `window.open` calls to the OS
 * browser instead of opening an in-app window. So child hosts are published on
 * the **main host's own origin** under `/mv/<id>/` by a reverse proxy
 * registered here, which forwards HTTP and the `/api/remote.mux` WebSocket
 * upgrade and attaches the child's session cookie itself, so the child's launch
 * token never reaches the page.
 *
 * Because the desktop preload runs only in the top frame, the child document
 * boots as a plain web client. Its own index is therefore served with one
 * injected global — `__DSH_TRANSPORT__` — pointing its transport at the
 * sub-interface's own mount, exactly as the desktop shell points the top frame
 * at the main host. That is what makes the child's Remote stream WebSocket
 * resolve to a URL the shell's own request rewriting accepts.
 *
 * ## Model configuration
 *
 * Credentials already live in `$DSH_HOME/.credentials.yaml`, which every
 * profile shares. On top of that, the model-defining rows of the *main*
 * profile's own patch layer are mirrored into each child profile as a generated
 * overlay, so the main interface's model selection and provider catalogue are
 * in force in every sub-interface and follow later changes.
 *
 * The Host half is plain ESM with no imports, per the official no-build plugin
 * template, so it activates on any dsh composition without a bundler.
 *
 * @module dsh-multiview
 */

/** Stable Cordis plugin name. */
export const name = 'multiview'

/** Services required before the supervisor can mount. */
export const inject = ['webServer']

// The Host half imports nothing but node builtins, matching the official
// no-build plugin template and every external plugin in the wild: a plugin that
// imports a Harness package breaks whenever that package changes shape, and it
// needs the loader's module resolution to be in a particular state. Row config
// is therefore validated here rather than through a schema export.
//
// `join as joinPath` sits at module scope because the workspace-isolation code
// needs it in several methods; a builtin is not a package whose shape can drift.
import { randomUUID } from 'node:crypto'
import { join as joinPath } from 'node:path'

/** Every proxy route lives under this prefix on the main host's origin. */
const ROUTE_PREFIX = '/mv'
/** `/mv/<id>/<rest>` — the view id and the remainder forwarded to the child. */
const VIEW_PATH = /^\/mv\/([A-Za-z0-9_-]{1,64})(\/.*)?$/
/** The one exact WebSocket pathname a child host multiplexes Remote streams on. */
const STREAM_PATH = 'api/remote.mux'
/** Generated overlay filename inside a child profile. */
const OVERLAY_NAME = 'cordis.multiview.yml'
/** Reserved sub-interface ids that are not real views. */
const RESERVED_IDS = new Set(['api', 'file', 'self-url', 'assets'])

/**
 * Headers that belong to a single HTTP hop and therefore must never be relayed
 * to the next one (RFC 9110 §7.6.1), plus anything named by `Connection`.
 *
 * `expect` is the reason this list exists. It is not decoration: undici's
 * `fetch` refuses any request that carries it (`UND_ERR_NOT_SUPPORTED`), so
 * relaying a client's `Expect: 100-continue` made the proxy's fetch to the child
 * throw, which surfaced as `HTTP 502` and, in the UI, as
 * "新建会话失败：… transport failure for /api/session/create: HTTP 502".
 * Clients add that header on their own — .NET's `HttpWebRequest` sends it with
 * every POST body, for instance — so it arrives without the page's knowledge,
 * and a proxy that relays it turns a perfectly good request into a dead hop.
 */
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
]

/**
 * Cookie a browser window carries after it exchanges its one-shot ticket.
 *
 * A browser window holds none of this app's cookies, so a ticket alone would
 * authenticate exactly one request — the document — and leave every asset, RPC
 * and the Remote stream socket unauthenticated. The ticket therefore buys a
 * scoped session cookie, which the browser then attaches to all of them.
 */
const WINDOW_COOKIE = 'dshMultiviewWindow'

/** Query parameter carrying that one-shot ticket. */
const WINDOW_TICKET_QUERY = 'mvTicket'

/**
 * Query parameter naming the session a window should open at.
 *
 * DSH's client has no URL deep link for a session — `dsh-client-ui-subagent` is
 * the only client plugin that reads query parameters at all — so a window is
 * pointed at one session by priming the client's own `dsh.sessions.current`
 * entry before its scripts run. That is an internal key, so it is primed
 * best-effort: if the shape ever changes, the window still opens, just at
 * whatever session the client would have restored on its own.
 */
const WINDOW_SESSION_QUERY = 'mvSession'

/**
 * Plugin configuration, applied from the row's `config` in `cordis.patch.yml`.
 *
 * Every field is optional: {@link resolveConfig} starts from these defaults and
 * overrides only the fields the row actually supplies, so a missing or partial
 * section never disables the plugin. The Settings plugin inventory shows the
 * row's own config text, which is where these values are edited.
 */
export const DEFAULTS = {
  /** Start a child host on first use; disabling fails loudly instead of spawning. */
  autoStart: true,
  /** Upper bound on concurrently running child hosts. */
  maxViews: 8,
  /**
   * Long-press a sidebar workspace row to open that workspace in its own window.
   *
   * **Off by default: the feature is shelved.** The endpoint and the whole path
   * stay implemented and tested — this only keeps the gesture from firing, so
   * nothing surprising happens while the idea is parked. Set it to `true` to try
   * it again; the client reads the value from `/mv/api/list`.
   */
  workspaceWindows: false,
  /** Milliseconds a child host may take to report its authenticated URL. */
  startTimeoutMs: 120000,
  /**
   * Authentication for `/mv/**`.
   *
   * `required` (the default) accepts only a request that is either
   *   - already carrying this app's own session — what the desktop shell injects
   *     into the in-app frame and its Remote stream socket, or
   *   - holding a browser-window session minted from a one-shot ticket.
   *
   * Everything else is refused, so a stray local process can no longer drive a
   * sub-interface. `off` restores the pre-0.2 behaviour (any local process could
   * reach a mount) and exists only as an escape hatch: if a composition has no
   * `connection` service there is nothing to authenticate against, and `off` is
   * how such a deployment keeps working.
   */
  mountAuth: 'required',
  /**
   * Browser executable for `--app` windows. Empty means "detect it": the
   * configured default browser when it is Chromium-based, else Edge/Chrome from
   * their usual install locations, else the platform's URL opener as a plain
   * tab. Set it to pin one (tests use this to stand in for a real browser).
   */
  browserCommand: '',
  /** Milliseconds a browser window's session cookie stays valid. */
  windowSessionMs: 12 * 60 * 60 * 1000,
  /** Profile name prefix for generated sub-interface profiles. */
  profilePrefix: 'dsh-multiview-',
  /** Shipped profile template a new sub-interface is initialized from. */
  profileTemplate: 'web',
  /**
   * Give every sub-interface its own workspace registry and session store.
   *
   * On, each sub-interface sees only the workspaces it was seeded with and only
   * the sessions created in it: archiving, pinning, or renaming anything there
   * leaves the main interface alone, and vice versa. Off restores the shared
   * stores for a sub-interface created by an older build.
   *
   * The stores are redirected by overriding the `storage-json` and
   * `session-persistence-jsonl` rows in the generated overlay, which is what
   * makes this a plain configuration change rather than new machinery.
   */
  isolateWorkspaces: true,
  /**
   * Directory name, inside a sub-interface's own profile, holding the isolated
   * stores. Keeping it inside the profile is deliberate: the profile is what
   * "reset" already deletes safely, so the data can never be orphaned.
   */
  dataDirName: 'multiview-data',
  /**
   * What a **newly created** sub-interface starts with, plugin-wise.
   *
   * `official` (the default) means the shipped `web` template and nothing else:
   * the main interface's *third-party* packages are not even declared, so the
   * sub-interface's plugin page lists nothing but the official bundles until its
   * operator brings something over with the "sync plugins from the main
   * interface" action. That keeps creation predictable — a new sub-interface
   * cannot inherit a plugin that breaks it — and it makes the copy an explicit,
   * reversible choice.
   *
   * `offered` restores the earlier behaviour, where the main profile's
   * third-party packages are declared (and linked) but left switched off, so they
   * appear in the plugin page ready to enable.
   *
   * Either way the main interface's **official plugin configuration** still
   * follows: every official row present in the main profile's patch layer is
   * mirrored into the generated overlay on every start (see
   * `mirrorOfficialRows`), so an official-plugin setting changed in the main
   * interface — theme, general settings, chat transcript view — is in force
   * here too, while third-party plugins stay out unless explicitly copied.
   */
  initialPlugins: 'official',
  /**
   * Mirror the main interface's official-plugin configuration rows into every
   * sub-interface.
   *
   * Third-party plugins are what isolation exists to keep out. The official
   * plugins are different: every sub-interface already *loads* them (its
   * profile is initialized from the official `web` template), and a setting
   * configured on an official plugin in the main interface's patch layer is a
   * machine preference, not a capability. Leaving it unmapped meant a sub-
   * interface silently ran the shipped defaults for every official plugin the
   * main interface had configured.
   *
   * A row is mirrored only when the same row id also exists in the
   * sub-interface's own patch layer — the child's layer is the proof it
   * actually loads that plugin, which is exactly the guard the third-party
   * copy skips by design. The row is taken **from the main profile's patch
   * layer** and written last into the generated overlay, so it wins over the
   * template's default and follows later edits in the main interface.
   */
  mirrorOfficialRows: true,
  /** Main-profile patch rows mirrored into every sub-interface. */
  sharedRowIds: [
    'agent-default-model',
    'llm-pi-ai',
    'llm-deepseek',
    'llm-deepseek-account',
    'subagent-model-selection-settings',
    'ui-model-selection',
  ],
}

/** Merge the row's config over the defaults, ignoring malformed fields. */
function resolveConfig(raw) {
  const config = { ...DEFAULTS }
  if (typeof raw !== 'object' || raw === null) return config
  if (typeof raw.autoStart === 'boolean') config.autoStart = raw.autoStart
  if (Number.isSafeInteger(raw.maxViews) && raw.maxViews >= 1 && raw.maxViews <= 32) config.maxViews = raw.maxViews
  if (Number.isSafeInteger(raw.startTimeoutMs) && raw.startTimeoutMs >= 1000) config.startTimeoutMs = raw.startTimeoutMs
  if (raw.mountAuth === 'required' || raw.mountAuth === 'off') config.mountAuth = raw.mountAuth
  if (typeof raw.workspaceWindows === 'boolean') config.workspaceWindows = raw.workspaceWindows
  if (typeof raw.browserCommand === 'string') config.browserCommand = raw.browserCommand
  if (Number.isSafeInteger(raw.windowSessionMs) && raw.windowSessionMs >= 60_000) config.windowSessionMs = raw.windowSessionMs
  if (typeof raw.profilePrefix === 'string' && /^[a-z0-9-]{1,32}$/.test(raw.profilePrefix)) config.profilePrefix = raw.profilePrefix
  if (typeof raw.profileTemplate === 'string' && raw.profileTemplate !== '') config.profileTemplate = raw.profileTemplate
  if (typeof raw.isolateWorkspaces === 'boolean') config.isolateWorkspaces = raw.isolateWorkspaces
  if (typeof raw.dataDirName === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(raw.dataDirName)) config.dataDirName = raw.dataDirName
  if (raw.initialPlugins === 'official' || raw.initialPlugins === 'offered') config.initialPlugins = raw.initialPlugins
  if (typeof raw.mirrorOfficialRows === 'boolean') config.mirrorOfficialRows = raw.mirrorOfficialRows
  if (Array.isArray(raw.sharedRowIds) && raw.sharedRowIds.every((id) => typeof id === 'string')) config.sharedRowIds = raw.sharedRowIds
  return config
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Loopback fence for the proxy routes, behaviourally identical to the `/api`
 * gateway fence: the Host header must name loopback and any browser-attached
 * Origin must agree. This is a DNS-rebinding / cross-site defence, not
 * authentication — the child host's own cookie authenticates the request.
 * @param req - node HTTP request.
 * @returns true when the request may reach a sub-interface.
 */
function isTrustedRequest(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const hostname = hostUrl.hostname
  const isLoopback = hostname === 'localhost'
    || hostname === '[::1]'
    || hostname === '::1'
    || (/^127(?:\.\d{1,3}){3}$/.test(hostname) && hostname.split('.').every((part) => Number(part) <= 255))
  if (!isLoopback) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    // The page's own origin is the desktop scheme; every other origin must at
    // least agree on the hostname.
    const parsed = new URL(origin)
    return parsed.hostname === hostname || parsed.protocol === 'dsh-app:'
  } catch {
    return false
  }
}

/** One cookie's value out of a `Cookie` header, or undefined. */
function cookieValue(header, name) {
  if (typeof header !== 'string' || header === '') return undefined
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at === -1) continue
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return undefined
}

/** Read and JSON-parse a bounded request body. */
function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('multiview: request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`multiview: invalid JSON body: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
  })
}

/** Write a JSON response. */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Sanitize a label into a path- and profile-safe identifier. */
function slugify(value, fallback = 'view') {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug === '' ? fallback : slug
}

// ---------------------------------------------------------------------------
// Stable port allocation
// ---------------------------------------------------------------------------

/**
 * First port of the sub-interface port band.
 *
 * Each sub-interface gets a deterministic port in this band so its own address
 * (the one a browser window opens directly, where plugins that talk to their
 * host half work) survives a restart. The band starts well above the typical
 * ephemeral range and away from the desktop host's own port.
 */
const PORT_BAND_BASE = 21900
/** Port band size; exhausted bands wrap the deterministic pick into the next. */
const PORT_BAND_SIZE = 800
/** How many consecutive occupied ports the allocator walks past. */
const PORT_PROBE_LIMIT = 32

/**
 * Resolve a genuinely free stable port for one sub-interface id.
 *
 * The pick is deterministic — the same id hashes to the same slot every time —
 * so a window opened on the child's own address keeps working across restarts.
 * A slot that some other program occupies is skipped by walking forward, and
 * the walk is bounded: 800 ports make a collision unlikely and 32 probes keep
 * a pathological machine from stalling the start.
 *
 * Every candidate is checked the way the child will bind it — listening on
 * `127.0.0.1` — so an already-bound port is never handed out. The probe closes
 * before returning; a tiny race window between close and the child's bind
 * remains, which is the same window every "find a free port" helper lives with.
 *
 * Exported for the regression suite: the deterministic-reuse and occupied-skip
 * properties are exactly what a browser window on the child's own address
 * depends on, so they are asserted against the real allocator rather than a
 * re-implementation.
 *
 * @param id - the sub-interface id.
 * @returns a promise resolving to a free port in the stable band, or 0 (the
 *   OS picks) when the band is exhausted — a degraded address for that one
 *   view until a port frees up, and strictly better than failing the start.
 */
export async function allocateStablePort(id) {
  const { createHash } = await import('node:crypto')
  const { createServer } = await import('node:net')
  const digest = createHash('sha256').update(`dsh-multiview:${id}`).digest()
  const base = PORT_BAND_BASE + (digest.readUInt16BE(0) % PORT_BAND_SIZE)
  for (let offset = 0; offset < PORT_PROBE_LIMIT; offset += 1) {
    const port = base + offset
    const free = await new Promise((resolve) => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true))
      })
    })
    if (free) return port
  }
  // The band is exhausted: fall back to the OS. The address-stability property
  // degrades for this one view until a port frees up, which is strictly better
  // than failing the start.
  return 0
}

/**
 * Split a patch file into its top-level `- ` entry blocks.
 * The loader's patch dialect is a top-level YAML array, so a line starting at
 * column 0 with `- ` begins exactly one entry.
 * @param text - raw patch file contents.
 * @returns one block per entry, comments and blank lines retained.
 */
function splitPatchEntries(text) {
  const lines = text.split(/\r?\n/)
  const blocks = []
  let current
  for (const line of lines) {
    if (/^-(\s|$)/.test(line)) {
      if (current !== undefined) blocks.push(current)
      current = [line]
      continue
    }
    if (current !== undefined) current.push(line)
  }
  if (current !== undefined) blocks.push(current)
  return blocks.map((block) => block.join('\n'))
}

/** The `id:` an entry block targets, or undefined. */
function entryId(block) {
  return /^- id:\s*(.+?)\s*$/m.exec(block)?.[1]?.replace(/^['"]|['"]$/g, '')
}

/**
 * The top-level `name:` an entry block declares, or undefined.
 *
 * A patch entry's package name sits at the entry's own indentation — the
 * column right after the `- ` dash, i.e. exactly two spaces, or on the dash
 * line itself — never under a `config:` section. `fieldValue` cannot answer
 * this: it only reads fields beneath a `config:`, and `name:` is a sibling of
 * that section, not a child of it.
 *
 * @param block - one entry block from a patch file.
 * @returns the entry's package name, unquoted, or undefined when unstated.
 */
function entryName(block) {
  const found = /^- name:\s*(.+?)\s*$|^ {2}name:\s*(.+?)\s*$/m.exec(block)
  const value = found?.[1] ?? found?.[2]
  return value?.replace(/^['"]|['"]$/g, '')
}

/**
 * Read one scalar field out of an entry block's `config:` section.
 *
 * Only the shapes this plugin writes are understood: a plain `key: value` line
 * under `config:`, indented deeper than `config:` itself. Anything else yields
 * undefined, which callers treat as "not stated" rather than as a value — that
 * matters because the caller's decision is whether to trust a provider name, and
 * guessing one would reintroduce the failure this guards against.
 *
 * @param block - one entry block from a patch file.
 * @param key - the field name to read.
 * @returns the field's value, or undefined when absent or unreadable.
 */
function fieldValue(block, key) {
  const lines = block.split(/\r?\n/)
  const configAt = lines.findIndex((line) => /^\s*config:\s*$/.test(line))
  if (configAt === -1) return undefined
  const configIndent = lines[configAt].length - lines[configAt].trimStart().length
  for (let index = configAt + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    // A shallower line ends the config section.
    if (indent <= configIndent) return undefined
    const match = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`).exec(line)
    if (match !== null) return match[1].replace(/^['"]|['"]$/g, '')
  }
  return undefined
}

/**
 * The provider names an entry block would register.
 *
 * Two shapes matter, and both appear in a real patch layer:
 *
 *   - a `provider: <name>` scalar, as on the model-selection row;
 *   - a `providers:` table whose child keys are provider names, as on a
 *     configurable provider catalogue.
 *
 * The table's keys sit exactly one level under `providers:`, so the section ends
 * at the first line indented no deeper than the `providers:` key itself.
 *
 * @param block - one entry block from a patch file.
 * @returns every provider name the block declares.
 */
function providersInBlock(block) {
  const found = new Set()
  const direct = fieldValue(block, 'provider')
  if (direct !== undefined) found.add(direct)

  const lines = block.split(/\r?\n/)
  const at = lines.findIndex((line) => /^\s*providers:\s*$/.test(line))
  if (at === -1) return found
  const tableIndent = lines[at].length - lines[at].trimStart().length
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (indent <= tableIndent) break
    const key = new RegExp(`^ {${String(tableIndent + 2)}}([A-Za-z0-9][A-Za-z0-9_-]*):\\s*$`).exec(line)?.[1]
    if (key !== undefined) found.add(key)
  }
  return found
}

// ---------------------------------------------------------------------------
// Profile teardown
// ---------------------------------------------------------------------------

/**
 * Delete a sub-interface profile directory without following a link out of it.
 *
 * This is the only supported way to delete one, for a reason that has already
 * bitten twice: the links this plugin creates in a sub-interface's
 * `node_modules` point at the **main** profile's own package copies, and
 * Windows' `fs.rmSync(dir, { recursive: true })` walks a junction into its
 * target. Deleting a sub-interface the obvious way therefore empties the main
 * profile's plugins, and the main interface then reports "cannot resolve profile
 * bundle …". So every link is unlinked first: the ones recorded in the
 * `.multiview-links.json` ledger this plugin writes, and — belt and braces —
 * anything else under the tree that turns out to be a link (pnpm's own linker
 * can create some too, depending on `nodeLinker`).
 *
 * @param dir - absolute profile directory.
 * @param profilePrefix - the generated-profile prefix, as a safety check.
 * @returns what was removed.
 */
async function removeProfileDirectory(dir, profilePrefix) {
  const { existsSync, readdirSync, lstatSync, unlinkSync, rmSync, readFileSync } = await import('node:fs')
  const { basename, join, resolve } = await import('node:path')
  const target = resolve(dir)
  if (!existsSync(target)) return { removed: false, links: 0, names: [] }
  // A path that is not a generated sub-interface profile is never this plugin's
  // to delete; a bad id must not become deleting an unrelated directory.
  if (!basename(target).startsWith(profilePrefix)) {
    throw new Error(`multiview: refusing to delete ${JSON.stringify(target)}: it is not a "${profilePrefix}*" profile`)
  }

  const names = []
  const ledgerPath = join(target, '.multiview-links.json')
  try {
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    for (const link of ledger.links ?? []) {
      if (typeof link?.name === 'string') names.push(link.name)
    }
  } catch {
    /* no ledger: the recursive unlink below is still the authority */
  }

  let links = 0
  const unlinkLinks = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      let stats
      try {
        stats = lstatSync(path)
      } catch {
        continue
      }
      if (stats.isSymbolicLink()) {
        try {
          unlinkSync(path)
          links += 1
        } catch {
          /* keep going; rmSync below reports what it cannot remove */
        }
        continue
      }
      if (stats.isDirectory()) unlinkLinks(path)
    }
  }
  unlinkLinks(target)
  rmSync(target, { recursive: true, force: true })
  return { removed: true, links, names }
}

// ---------------------------------------------------------------------------
// Workspace isolation
// ---------------------------------------------------------------------------

/**
 * Build the workspace registry document a sub-interface starts from.
 *
 * A sub-interface with its own `storages` root boots with an **empty** registry,
 * and nothing fills it afterwards: `session/create` with only a `cwd` succeeds
 * without registering the directory, and the runtime's own "initialize the
 * default workspace" path does not fire for this shape. Left alone, every
 * sub-interface would show an empty sidebar, which reads as "the feature is
 * broken" rather than "you have not added a workspace here yet".
 *
 * So the main interface's workspace records are copied in as the starting set,
 * with two deliberate changes:
 *
 *  - `sessionIds` is emptied. Those sessions belong to the main interface's
 *    store; this registry indexes its own, and claiming sessions that are not
 *    here would list conversations that cannot be opened.
 *  - The global archive/pin sets are emptied for the same reason. They are
 *    registry-wide rather than per-recording, which is exactly the sharing this
 *    isolation exists to remove.
 *
 * `path` is carried over verbatim: it is already the canonical spelling the main
 * registry stamped at create time, and re-canonicalizing would reject a
 * directory that has since been moved or deleted.
 *
 * @param mainRegistry - parsed main `workspace.json`, or undefined when unreadable.
 * @returns the parsed document to write, or undefined when there is nothing to seed.
 */
function seedWorkspaceRegistry(mainRegistry) {
  const records = mainRegistry?.tables?.workspaces
  if (typeof records !== 'object' || records === null) return undefined
  const workspaces = {}
  const workspaceIds = []
  for (const [id, record] of Object.entries(records)) {
    if (typeof record?.path !== 'string' || record.path === '') continue
    const now = new Date().toISOString()
    workspaces[id] = {
      path: record.path,
      title: typeof record.title === 'string' && record.title !== '' ? record.title : record.path,
      sessionIds: [],
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : now,
      updatedAt: now,
    }
    workspaceIds.push(id)
  }
  return {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds, archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces },
  }
}

/**
 * The session store's directory name for one workspace directory.
 *
 * This is a faithful re-implementation of `projectKey` in
 * `@deepseek-ai/dsh-session-persistence-jsonl`, and it has to match **exactly**:
 * the sub-interface looks its sessions up under this name, so a wrong spelling
 * means copied sessions that are never found. The rules, as the runtime applies
 * them:
 *
 *  - a run of `/`, `\` or `:` collapses to a single `-`;
 *  - `[A-Za-z0-9._-]` stays literal, `~` included in the escaped set;
 *  - anything else becomes `~XXXX` (uppercase hex of the UTF-16 code unit);
 *  - leading dashes are stripped, an empty body becomes `root`;
 *  - the body is capped at 251 characters, wrapped in `--…--`.
 *
 * The transformation is lossy by design (the runtime documents it as
 * "human-navigable"), which is why a caller must pass the same absolute path the
 * session was created with.
 *
 * @param cwd - the session's project directory.
 * @returns the single filesystem-safe directory name.
 */
function projectKeyOf(cwd) {
  let readable = ''
  let separatorRun = false
  for (const character of cwd) {
    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
      continue
    }
    if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) {
      readable += character
      separatorRun = false
      continue
    }
    readable += `~${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
    separatorRun = false
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

// ---------------------------------------------------------------------------
// Child host
// ---------------------------------------------------------------------------

/**
 * One sub-interface: a child `dsh` process owning its own profile.
 *
 * Started through the installation's own launcher, which sets
 * `ELECTRON_RUN_AS_NODE` and resolves the packaged runtime, so a child runs the
 * exact same dsh build as its parent instead of a separately installed copy.
 */
class ChildHost {
  constructor({ id, profile, runtime, cwd, config, log, overlayPath }) {
    this.id = id
    this.profile = profile
    this.runtime = runtime
    this.cwd = cwd
    this.config = config
    this.log = log
    /** The generated model-configuration overlay applied to this child. */
    this.overlayPath = overlayPath
    this.child = undefined
    this.origin = undefined
    this.tokenUrl = undefined
    this.cookie = undefined
    this.state = 'stopped'
    this.error = undefined
    this.startedAt = undefined
    this.stderr = ''
    this.ready = undefined
  }

  /** Snapshot for the client half. Never carries the token or cookie. */
  describe() {
    return {
      id: this.id,
      profile: this.profile,
      state: this.state,
      error: this.error,
      startedAt: this.startedAt,
      /** Origin-relative base the page loads this sub-interface from. */
      basePath: `${ROUTE_PREFIX}/${this.id}/`,
      /** Exact upgrade pathname the child's Remote stream socket lives on. */
      streamPath: `${ROUTE_PREFIX}/${this.id}/${STREAM_PATH}`,
      /**
       * The child's own origin, without the token. Lets the client half show
       * "this view runs at its own address" and reason about window mode;
       * the token-bearing URL is only ever minted on demand by /window-url.
       */
      ownOrigin: this.origin,
    }
  }

  /** Start the child host; resolves with this view's proxied base path. */
  start() {
    this.ready ??= this.#spawn()
    return this.ready
  }

  async #spawn() {
    const { spawn } = await import('node:child_process')
    this.state = 'starting'
    this.error = undefined
    this.stderr = ''

    // The child binds a STABLE, deterministic port (see `portForView`) instead
    // of `--port 0`. A stable port is what lets a browser window keep pointing
    // at the child's OWN address across restarts — the address is what makes
    // plugins that talk to their own host half work in that window — while the
    // allocator still moves out of the way when a port is taken.
    //
    // `--patch <overlay>` is what actually applies the mirrored model
    // configuration: a profile only auto-loads its own `cordis.patch.yml`, so a
    // generated file must be named as a launcher patch layer. Launcher flags
    // must precede the app's own arguments, because the first token the
    // launcher does not recognize starts the app's argument list.
    const args = [
      ...this.runtime.prefixArgs,
      this.profile,
      ...(this.overlayPath === undefined ? [] : ['--patch', this.overlayPath]),
      '--no-open', '--port', String(await allocateStablePort(this.id)),
    ]
    const child = spawn(this.runtime.command, args, {
      cwd: this.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: this.runtime.env,
      ...(this.runtime.shell === true ? { shell: true } : {}),
    })
    this.child = child

    const authenticated = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`multiview: sub-interface ${this.id} did not report a URL within ${String(this.config.startTimeoutMs)}ms`))
      }, this.config.startTimeoutMs)
      timer.unref?.()

      let buffer = ''
      const consume = (chunk) => {
        buffer += chunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          // The launcher prints exactly one line carrying the authenticated URL.
          const found = /(https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/.exec(line)
          if (found === null) continue
          clearTimeout(timer)
          resolve(found[1])
          return
        }
      }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', consume)
      child.stderr.on('data', (chunk) => {
        this.stderr = (this.stderr + chunk).slice(-16384)
        consume(chunk)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`multiview: could not launch sub-interface ${this.id}: ${error.message}`))
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`multiview: sub-interface ${this.id} exited with code ${String(code)} before reporting a URL${this.stderr.trim() === '' ? '' : `: ${this.stderr.trim().split(/\r?\n/).at(-1)}`}`))
      })
    })

    child.once('exit', (code) => {
      this.state = 'stopped'
      this.origin = undefined
      this.cookie = undefined
      this.tokenUrl = undefined
      this.ready = undefined
      this.child = undefined
      this.log.info('multiview: sub-interface %s exited (code %s)', this.id, String(code))
    })

    let tokenUrl
    try {
      tokenUrl = await authenticated
    } catch (error) {
      this.state = 'failed'
      this.error = error instanceof Error ? error.message : String(error)
      this.#kill()
      throw error
    }

    // Exchange the launch token for the child's session cookie here, in the
    // Host. The page never sees the token, and the proxy attaches the cookie.
    try {
      const response = await fetch(tokenUrl, { redirect: 'manual' })
      const setCookie = response.headers.get('set-cookie')
      await response.body?.cancel()
      if (response.status !== 303 || setCookie === null) {
        throw new Error(`multiview: sub-interface ${this.id} authentication failed (HTTP ${String(response.status)})`)
      }
      const end = setCookie.indexOf(';')
      this.cookie = end < 0 ? setCookie : setCookie.slice(0, end)
    } catch (error) {
      this.state = 'failed'
      this.error = error instanceof Error ? error.message : String(error)
      this.#kill()
      throw error
    }

    this.tokenUrl = tokenUrl
    this.origin = new URL(tokenUrl).origin
    this.state = 'running'
    this.startedAt = Date.now()
    this.log.info('multiview: sub-interface %s ready at %s', this.id, this.origin)
    return `${ROUTE_PREFIX}/${this.id}/`
  }

  /**
   * The child's own authenticated URL, used to open the sub-interface in a real
   * separate window. It carries the child's launch token, so it is only ever
   * handed to the shell's external-open path, never rendered into the page.
   */
  externalUrl() {
    return this.tokenUrl
  }

  /**
   * Terminate the child host, leaving this object startable again.
   *
   * Every field the spawn installed is cleared, not just the process: `start`
   * memoizes its first attempt in `ready`, so a stop that left `ready` in place
   * would make the next start resolve instantly with a stale URL and a cookie for
   * a process that is gone — the sub-interface would show a dead frame and no
   * error. Clearing the memo is what makes stop-then-start (the "reopen" and
   * "clear data" paths) actually spawn a fresh host.
   */
  async stop() {
    const child = this.child
    this.child = undefined
    this.ready = undefined
    this.tokenUrl = undefined
    this.origin = undefined
    this.cookie = undefined
    this.startedAt = undefined
    if (child === undefined) {
      this.state = 'stopped'
      return
    }
    const exited = new Promise((resolve) => child.once('exit', resolve))
    // `#kill` reads `this.child`, which was just cleared, so kill this handle.
    try {
      if (!child.killed) child.kill()
    } catch {
      /* already gone */
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))])
    this.state = 'stopped'
  }

  #kill() {
    const child = this.child
    if (child === undefined || child.killed) return
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Host-side owner of every sub-interface, published as `ctx.multiview`. */
class MultiViewService {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    /** @type {Map<string, ChildHost>} */
    this.views = new Map()
    /** @type {Map<string, () => void>} */
    this.upgradeRoutes = new Map()
    this.log = ctx.logger('multiview')
    this.runtime = undefined
    this.home = undefined
    this.mainPatchPath = undefined
    this.mainOrigin = undefined
    this.mainAuthValue = undefined
    /** One-shot capability tickets for the file viewer. @type {Map<string, {path: string, expiresAt: number}>} */
    this.fileTickets = new Map()
    /** One-shot tickets a browser window exchanges for a session. @type {Map<string, {id: string, expiresAt: number}>} */
    this.windowTickets = new Map()
    /** Live browser-window sessions, keyed by cookie value. @type {Map<string, {id: string, expiresAt: number}>} */
    this.windowSessions = new Map()
    /** Browser processes per id, so closing a sub-interface closes them too. @type {Map<string, Set<unknown>>} */
    this.externalWindows = new Map()
    /** Whether the "no connection service" warning has been emitted. */
    this.warnedNoConnection = false
    /**
     * The workspace directory each sub-interface was last working in.
     *
     * This is the memory behind 重新打开 and 复制打开: a restarted child's
     * client falls back to whichever workspace its sidebar sorts first, which
     * read as "it jumped to another workspace". Recording the directory the
     * operator was actually in lets a restart land back there.
     *
     * Keyed by view id, holding `{ cwd, workspaceId? }`. Survives stop/start
     * of the child (it lives here, not in the child), cleared with the view.
     * @type {Map<string, {cwd: string, workspaceId?: string}>}
     */
    this.currentWorkspaces = new Map()
  }

  /**
   * Resolve how to run a child `dsh` host, `$DSH_HOME`, and the main patch path.
   *
   * Windows cannot `spawn` a `.cmd` without a shell (it fails with `EINVAL`), so
   * the recipe copies what the desktop shell itself does: run the runtime
   * executable with `ELECTRON_RUN_AS_NODE=1` and hand it the desktop-host CLI
   * entry directly. That is also what gives the child asar-aware module
   * resolution, so it loads the packaged dsh runtime from inside `app.asar`
   * rather than needing a separately installed copy.
   *
   * A launch that is not Electron (a plain `dsh web` from a terminal) falls back
   * to running the same runtime's `bin.js` under the current Node, which needs no
   * asar support because the runtime is then a real directory.
   *
   * @returns `{ command, prefixArgs, env, runtimeDir }` for every child spawn.
   */
  async resolveRuntime() {
    if (this.runtime !== undefined) return this.runtime
    const { existsSync } = await import('node:fs')
    const { join, delimiter, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')

    /** Whether a directory is a dsh runtime root. */
    const isRuntime = (directory) => directory !== undefined
      && existsSync(join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))

    /** Walk up from a path looking for the runtime root. */
    const walkUp = (from) => {
      let directory = from
      for (let depth = 0; depth < 14; depth += 1) {
        if (isRuntime(directory)) return directory
        const parent = dirname(directory)
        if (parent === directory) break
        directory = parent
      }
      return undefined
    }

    const candidates = []
    // 1. An explicit override. This is also how a test drives the real spawn
    //    path without being the Electron process itself.
    const override = process.env.DSH_MULTIVIEW_RUNTIME_DIR
    if (typeof override === 'string' && override !== '') candidates.push(override)
    // 2. The desktop installation. The Electron binary sits beside the
    //    `resources` directory, so the runtime is found from `process.execPath`
    //    regardless of where THIS plugin was installed — which matters because
    //    a plugin normally lives in a profile's own node_modules, not inside the
    //    runtime tree.
    if (typeof process.versions.electron === 'string') {
      const beside = dirname(process.execPath)
      candidates.push(join(beside, 'resources', 'app.asar', 'dsh'))
      candidates.push(join(beside, 'resources', 'app', 'dsh'))
    }
    // 3. This plugin's own ancestors, which covers being installed inside the
    //    runtime tree or running from a source checkout.
    try {
      candidates.push(walkUp(fileURLToPath(new URL('.', import.meta.url))))
    } catch {
      /* not a file URL */
    }

    // The explicit override is trusted as given; a discovered candidate must
    // actually look like a runtime. `existsSync` is asar-aware inside Electron,
    // which is why the desktop path above works without unpacking.
    const runtimeDir = typeof override === 'string' && override !== '' && existsSync(override)
      ? override
      : candidates.find((candidate) => isRuntime(candidate))
    const desktopCli = runtimeDir === undefined
      ? undefined
      : join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
    const binEntry = runtimeDir === undefined
      ? undefined
      : join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

    // The child must not inherit the parent's identity: a stale DSH_PROFILE or
    // session id would make it adopt the main profile instead of its own.
    const env = { ...process.env }
    for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL']) delete env[key]

    if (typeof process.versions.electron === 'string' && desktopCli !== undefined && existsSync(desktopCli)) {
      // Electron in Node mode: asar-aware, so the packaged runtime loads.
      this.runtime = { command: process.execPath, prefixArgs: ['--expose-internals', desktopCli], env, runtimeDir }
    } else if (binEntry !== undefined && existsSync(binEntry)) {
      // A plain Node launch of the same runtime.
      this.runtime = { command: process.execPath, prefixArgs: [binEntry], env, runtimeDir }
    } else {
      // Last resort: a `dsh` executable on PATH. This is the least reliable
      // path — a stale shim left by another install can be present but broken —
      // so it is only reached when no runtime directory was found at all, and
      // the failure it produces is reported with the resolved command so the
      // cause is visible instead of mysterious.
      let onPath
      const pathExt = process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']
      for (const directory of (process.env.PATH ?? '').split(delimiter)) {
        if (directory === '') continue
        for (const ext of pathExt) {
          const candidate = join(directory, `dsh${ext}`)
          if (existsSync(candidate)) { onPath = candidate; break }
        }
        if (onPath !== undefined) break
      }
      if (onPath === undefined) {
        throw new Error('multiview: could not locate the dsh runtime, so sub-interfaces cannot be started from this launch')
      }
      this.log.warn('multiview: falling back to the dsh on PATH (%s); set DSH_MULTIVIEW_RUNTIME_DIR to pin the runtime', onPath)
      // A `.cmd` shim cannot be spawned directly on Windows (`EINVAL`), so it
      // needs a shell.
      this.runtime = process.platform === 'win32'
        ? { command: onPath, prefixArgs: [], env, runtimeDir, shell: true }
        : { command: onPath, prefixArgs: [], env, runtimeDir }
    }

    // $DSH_HOME is read from the environment rather than by importing
    // dsh-home-paths, keeping this plugin free of runtime imports.
    this.home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')

    const profileName = this.ctx.get('profileContext')?.name
    if (typeof profileName === 'string' && profileName !== '') {
      this.mainPatchPath = join(this.home, 'profiles', profileName, 'cordis.patch.yml')
    }
    // The main host's own origin, for opening the main interface in a window.
    const port = this.ctx.get('webServer')?.port
    if (Number.isSafeInteger(port)) this.mainOrigin = `http://127.0.0.1:${String(port)}`
    return this.runtime
  }

  /**
   * Ensure a sub-interface profile exists, initialized from the shipped
   * template. Uses the launcher's `--dump-config` path, which performs profile
   * initialization and exits without binding a port.
   * @returns the profile directory.
   */
  async ensureProfile(viewId) {
    const { existsSync } = await import('node:fs')
    const { spawn } = await import('node:child_process')
    const { join } = await import('node:path')
    const dir = join(this.home, 'profiles', `${this.config.profilePrefix}${viewId}`)
    if (existsSync(join(dir, 'package.json'))) return dir

    await new Promise((resolve, reject) => {
      const child = spawn(this.runtime.command, [
        ...this.runtime.prefixArgs,
        `${this.config.profilePrefix}${viewId}`,
        '--from-default-profile', this.config.profileTemplate,
        '--dump-config',
      ], {
        cwd: this.home,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        env: this.runtime.env,
        ...(this.runtime.shell === true ? { shell: true } : {}),
      })
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096) })
      child.once('error', reject)
      child.once('exit', (code) => {
        // Profile initialization is proven by the manifest existing, not by the
        // exit code: `--dump-config` writes the profile then reports status.
        if (existsSync(join(dir, 'package.json'))) resolve()
        else reject(new Error(`multiview: could not initialize a profile for ${viewId} (exit ${String(code)})${stderr.trim() === '' ? '' : `: ${stderr.trim().split(/\r?\n/).at(-1)}`}`))
      })
    })
    return dir
  }

  /**
   * Mirror the main profile's model-defining patch rows into a sub-interface.
   *
   * Credentials already resolve from the shared `$DSH_HOME/.credentials.yaml`.
   * This copies the rows that decide *which* provider and model those
   * credentials are used for — the main interface's model selection and
   * provider catalogue — so a sub-interface boots with the main interface's
   * model configuration in force.
   *
   * A row is only mirrored when the sub-interface can actually serve it. The
   * model-selection row names a provider, and a provider is registered by a
   * plugin: the main profile may have it from a third-party bundle that this
   * sub-interface's own profile does not contain. Mirroring the row regardless
   * produces a selection naming a provider that does not exist here, and every
   * session created in the sub-interface then fails to resolve its default
   * model. So the selection row is skipped when its provider is unavailable, and
   * the sub-interface keeps the model its own profile declares.
   *
   * @param viewId - the sub-interface to write the overlay for.
   * @param seedOnly - a pre-filtered workspace registry to seed from instead of the
   *   main one, used when the caller chose a single starting workspace.
   * @returns the overlay path, the mirrored row ids, and any skipped for cause.
   */
  async syncModelConfiguration(viewId, seedOnly) {
    const { writeFile, readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const dir = await this.ensureProfile(viewId)
    const overlayPath = join(dir, OVERLAY_NAME)

    // Workspace isolation is applied as two extra rows in this same overlay, so
    // a sub-interface created by an older build gains it on its next start
    // without anything else being migrated. The registry is seeded first: the
    // child reads it once at boot, and an unseeded root leaves every sidebar
    // empty (see `seedWorkspaces`).
    let isolation
    if (this.config.isolateWorkspaces) {
      const seeded = await this.seedWorkspaces(viewId, seedOnly)
      if (seeded.seeded === false) {
        this.log.info('multiview: sub-interface %s kept its own workspace registry (%s)', viewId, String(seeded.reason))
      }
      const dataDir = this.dataDir(viewId)
      // Both roots are written with forward slashes: the value is YAML, and a
      // backslash there would be read as an escape.
      const asPosix = (value) => value.replaceAll('\\', '/')
      isolation = {
        relative: `profiles/${this.config.profilePrefix}${viewId}/${this.config.dataDirName}`,
        storages: asPosix(joinPath(dataDir, 'storages')),
        sessions: asPosix(joinPath(dataDir, 'sessions')),
      }
    }

    let rows = []
    let officialRows = []
    let source
    let skipped = []
    if (this.mainPatchPath !== undefined) {
      try {
        const text = await readFile(this.mainPatchPath, 'utf8')
        const wanted = new Set(this.config.sharedRowIds)
        const candidates = splitPatchEntries(text).filter((block) => {
          const id = entryId(block)
          return id !== undefined && wanted.has(id)
        })

        // Which providers will this sub-interface be able to serve once these
        // rows are applied? Two sources, and both are needed:
        //
        //   1. The child's own composed tree -- a provider its installed bundles
        //      already register.
        //   2. The mirrored CATALOGUE rows -- a row such as `llm-pi-ai` declares
        //      its providers in its own config, so mirroring it is what makes
        //      those providers exist here.
        //
        // The selection row is deliberately excluded from (2): it names the
        // provider it WANTS, so counting its own field would make every provider
        // look available and defeat the whole guard.
        const available = await this.#availableProviders(dir)
        for (const block of candidates) {
          const id = entryId(block)
          if (id === undefined || id === 'agent-default-model') continue
          for (const provider of providersInBlock(block)) available.add(provider)
        }

        for (const block of candidates) {
          const id = entryId(block)
          const provider = id === 'agent-default-model' ? fieldValue(block, 'provider') : undefined
          if (provider !== undefined && !available.has(provider)) {
            skipped.push({ id, provider })
            continue
          }
          rows.push(block)
        }

        // The main interface's official-plugin configuration follows every
        // sub-interface: an official plugin is one the child already loads
        // (its profile was initialized from the official template), so a
        // setting the main interface configured on one is a machine
        // preference, not a third-party capability. The row is mirrored only
        // when the child's OWN patch layer declares the same row id — the
        // child's layer is the proof it loads that plugin — and it is written
        // into the overlay after the shared model rows, so it wins.
        if (this.config.mirrorOfficialRows) {
          const childIds = await this.#childRowIds(dir)
          const bundles = (await this.#mainBundleNames()) ?? []
          const isOfficial = (name) => typeof name === 'string' && name.startsWith('@deepseek-ai/')
          for (const block of splitPatchEntries(text)) {
            const id = entryId(block)
            if (id === undefined || wanted.has(id)) continue
            const name = entryName(block)
              ?? bundles.find((bundle) => bundle === id || bundle.endsWith(`/${id}`))
            if (!isOfficial(name)) continue
            if (!childIds.has(id)) continue
            officialRows.push(block)
          }
        }
        source = this.mainPatchPath
      } catch (error) {
        this.log.warn('multiview: could not read the main profile patch (%s); the sub-interface keeps its own model rows', String(error))
      }
    }

    for (const entry of skipped) {
      this.log.warn(
        'multiview: sub-interface %s cannot serve provider %o, so the main interface\'s model selection was NOT mirrored; it keeps its own default. Install the plugin that provides it in this sub-interface, then start it again.',
        viewId, entry.provider,
      )
    }

    const header = [
      '# GENERATED by dsh-multiview — do not edit.',
      '#',
      "# Mirrors the main interface's model configuration into this sub-interface:",
      '# the rows below are copied from the main profile patch layer, so the model',
      '# selection and provider catalogue the main interface uses are in force here',
      '# too. Regenerated whenever a sub-interface starts.',
      '#',
      '# A row is omitted when this sub-interface cannot serve it -- the model',
      '# selection names a provider, and a provider comes from a plugin this',
      '# profile may not have. Mirroring such a row would leave every new session',
      '# unable to resolve its default model.',
      isolation === undefined
        ? '#'
        : `# Workspaces and sessions are isolated into ${isolation.relative} (see the two rows at the end).`,
      source === undefined ? '#' : `# source: ${source}`,
      skipped.length === 0 ? '#' : `# skipped (provider not available here): ${skipped.map((entry) => `${entry.id}=${String(entry.provider)}`).join(', ')}`,
      '#',
      '# Official-plugin configuration follows the main interface too: the rows',
      '# mirrored below carry settings configured on official plugins in the main',
      '# interface\'s patch layer. Third-party plugins are NOT brought over — they',
      `# stay out unless copied explicitly (official rows mirrored: ${String(officialRows.length)}).`,
      '',
    ].join('\n')

    // The isolation rows come last so they are the final layer and win: a patch
    // listed later overrides an earlier row with the same id, which is exactly
    // how the mirrored catalogue rows above are already overridden.
    const isolationRows = []
    if (isolation !== undefined) {
      // `root` is the documented config field of both rows; the values are
      // quoted because a Windows path contains a colon that bare YAML would read
      // as a mapping.
      isolationRows.push(
        '# --- Workspace isolation ---------------------------------------------',
        '# The sub-interface keeps its own workspace registry and session store, so',
        '# adding, renaming, archiving, pinning, or deleting a workspace or a',
        '# session here never touches the main interface (and vice versa).',
        '- id: storage-json',
        "  name: '@deepseek-ai/dsh-storage-json'",
        '  config:',
        `    root: '${isolation.storages}'`,
        '',
        '- id: session-persistence-jsonl',
        "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
        '  config:',
        `    root: '${isolation.sessions}'`,
      )
    }

    // An empty patch file fails profile boot, so an empty mirror is written as
    // an explicit empty array.
    const blocks = [...rows, ...officialRows, ...isolationRows]
    const body = blocks.length === 0 ? '[]\n' : `${blocks.join('\n\n')}\n`
    await writeFile(overlayPath, header + body, 'utf8')
    return {
      overlayPath,
      rows: rows.length,
      officialRows: officialRows.length,
      source,
      skipped,
      isolation: isolation?.relative,
    }
  }

  /**
   * The providers a sub-interface's own profile can serve.
   *
   * Read from the profile's composed tree, which is exactly what the child will
   * boot. Every `llm-*` row that reaches the tree contributes whatever its own
   * config declares, so the same parser the mirror uses applies here.
   *
   * A dump costs about 200ms and runs once per start, so it is not cached: a
   * stale answer would be worse than the cost, because the sub-interface's
   * plugin set can change between starts.
   *
   * @param dir - the sub-interface's profile directory.
   * @returns the set of provider names this profile declares.
   */
  async #availableProviders(dir) {
    const providers = new Set()
    try {
      const { spawn } = await import('node:child_process')
      const composed = await new Promise((resolve) => {
        const child = spawn(this.runtime.command, [...this.runtime.prefixArgs, this.#profileName(dir), '--dump-config'], {
          cwd: this.home,
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          env: this.runtime.env,
          ...(this.runtime.shell === true ? { shell: true } : {}),
        })
        let out = ''
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk) => { out += chunk })
        const timer = setTimeout(() => child.kill(), 60000)
        child.once('exit', () => { clearTimeout(timer); resolve(out) })
        child.once('error', () => { clearTimeout(timer); resolve('') })
      })

      for (const block of splitPatchEntries(composed)) {
        const id = entryId(block)
        if (id === undefined || !/^llm-/.test(id)) continue
        for (const provider of providersInBlock(block)) providers.add(provider)
      }
    } catch {
      /* An unreadable tree means "unknown", and the caller then mirrors nothing
         it cannot justify: the empty set keeps the child's own default. */
    }
    // The official provider ships with the shared base bundle, so it is always
    // servable even though no row spells it out.
    providers.add('deepseek-official')
    return providers
  }

  /** The profile name behind a profile directory. */
  #profileName(dir) {
    const parts = dir.split(/[\\/]/)
    return parts[parts.length - 1]
  }

  /**
   * The row ids a sub-interface's own patch layer declares.
   *
   * The child's user layer is the record of which plugins THIS sub-interface
   * actually configures, so it is also the safest proof of which plugins it
   * loads: an id present here names a row the child's own composition carries.
   * A dump would answer the same question from the composed tree, but it costs
   * a subprocess boot for information the layer already holds.
   *
   * @param dir - the sub-interface's profile directory.
   * @returns the set of row ids; empty when the layer is absent or unreadable
   *   (the caller then mirrors no official rows).
   */
  async #childRowIds(dir) {
    const ids = new Set()
    try {
      const { readFile } = await import('node:fs/promises')
      const text = await readFile(joinPath(dir, 'cordis.patch.yml'), 'utf8')
      for (const block of splitPatchEntries(text)) {
        const id = entryId(block)
        if (id !== undefined) ids.add(id)
      }
    } catch {
      /* no user layer: the template's defaults are the whole story */
    }
    return ids
  }

  /**
   * The main profile's own bundle names, or undefined when unreadable.
   *
   * Used only to name an entry whose patch row omits `name:` — the usual shape
   * of a bare disable row. A bundle listed in the manifest IS a plugin this
   * installation loads, so an id that matches one (exactly, or as the tail of
   * a scoped name) resolves to that package.
   *
   * @returns the bundle names, or undefined when the manifest cannot be read.
   */
  async #mainBundleNames() {
    if (this.mainPatchPath === undefined) return undefined
    try {
      const { readFile } = await import('node:fs/promises')
      const { dirname } = await import('node:path')
      const manifest = JSON.parse(await readFile(joinPath(dirname(this.mainPatchPath), 'package.json'), 'utf8'))
      const names = (manifest?.dsh?.profile?.bundles ?? []).filter((name) => typeof name === 'string' && name !== '')
      return names.length > 0 ? names : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Create (or adopt) a sub-interface.
   *
   * What a new sub-interface starts with is deliberately narrow:
   *
   *  - **Plugins**: the shipped `web` template, i.e. the official bundles. The
   *    main interface's community plugins are NOT declared unless
   *    `initialPlugins: 'offered'` asks for the older behaviour; the operator
   *    brings them over with the explicit "sync plugins" action instead.
   *  - **Workspaces**: isolated, and seeded with only the directory the caller
   *    chose (`workspaceId` or `cwd`). A sub-interface that adopted the whole
   *    main workspace list would make "pick a workspace" meaningless.
   *  - **Sessions**: isolated and empty. Sessions are never carried over
   *    implicitly; "sync sessions" is a separate, explicit action.
   *  - **Model configuration**: NOT isolated. The main interface's model rows are
   *    mirrored in on every start, which is what keeps a sub-interface usable
   *    without re-entering credentials or a model choice.
   *
   * @param input - `{ id?, label?, workspaceId?, cwd?, copyPlugins?, copySessions?, pluginMode? }`.
   */
  async open(input = {}) {
    const label = typeof input.label === 'string' && input.label.trim() !== '' ? input.label.trim() : 'view'
    const id = typeof input.id === 'string' && input.id !== '' ? input.id : slugify(label)
    if (RESERVED_IDS.has(id)) throw new Error(`multiview: ${JSON.stringify(id)} is a reserved sub-interface id`)
    const existing = this.views.get(id)
    if (existing !== undefined) return existing.describe()
    if (this.views.size >= this.config.maxViews) {
      throw new Error(`multiview: at most ${String(this.config.maxViews)} sub-interfaces may run at once`)
    }

    // How this sub-interface's plugins are meant to run. `main` (the default,
    // the 0.1 behaviour): third-party plugins may be copied in, but their
    // client halves talk to the main host, so they effectively run THROUGH the
    // main interface — the in-app frame and mount windows show official
    // plugins fine, while the front/back-half kind needs this view opened in
    // a browser window at its own address instead. `own`: the operator said
    // this view is for exactly that — plugins are copied in AND the view is
    // meant to be opened at its own address, where they run for real.
    const pluginMode = input.pluginMode === 'own' ? 'own' : 'main'
    this.pluginModes ??= new Map()
    this.pluginModes.set(id, pluginMode)
    if (pluginMode === 'own') {
      // A view created for independent plugins runs in a browser window at its
      // own address; the in-app frame is not its natural home. The client half
      // reads the same flag back through /list (pluginMode below) and shows
      // the "open the window" affordance for it.
      this.log.info('multiview: sub-interface %s created for own-address plugin mode', id)
    }

    const runtime = await this.resolveRuntime()
    // A creation request must NOT adopt an existing (closed, un-reset)
    // profile: 新建 means new. The settings page's 打开 passes
    // `resume: true` — reopening a closed sub-interface with its data intact
    // is exactly the point there. Without that flag, an existing profile is a
    // hard error telling the operator to use 打开 (or 重置) instead.
    const { existsSync } = await import('node:fs')
    const profileExists = existsSync(joinPath(this.home, 'profiles', `${this.config.profilePrefix}${id}`, 'package.json'))
    if (profileExists && input.resume !== true) {
      throw new Error(`multiview: ${JSON.stringify(id)} 已存在（一个已关闭标签页的数据还在磁盘上）。请在 设置 → 标签页设置 里点「打开」恢复它，或先「重置」再新建。`)
    }
    await this.ensureProfile(id)
    // `official` is the default: a new sub-interface is created with the official
    // bundles only, and the operator brings plugins over deliberately.
    if (this.config.initialPlugins === 'offered') await this.#offerThirdPartyBundles(id)
    // Isolation is applied by `syncModelConfiguration`, which also seeds the
    // workspace registry — with ONLY the workspace the caller picked, when one
    // was picked.
    const overlay = await this.syncModelConfiguration(id, await this.#resolveSeedWorkspaces(input))
    const chosen = await this.#registerChosenWorkspace(id, input)
    // The starting workspace is the first "current workspace": 重新打开 after
    // this must land back on it, not on whatever the sidebar sorts first.
    if (typeof input.cwd === 'string' && input.cwd !== '') {
      this.rememberCurrentWorkspace(id, input.cwd, typeof input.workspaceId === 'string' ? input.workspaceId : undefined)
    }

    // Creation-time copies, both explicit: the checkbox for plugins and the
    // checkbox for sessions in the new-sub-interface dialog land here, so a
    // fresh sub-interface can arrive already equipped without the operator
    // running the two sync actions by hand afterwards. Sessions are merged
    // BEFORE first boot, so the child's very first frame already lists them.
    if (input.copyPlugins === true) {
      try {
        const offered = await this.#offerThirdPartyBundles(id)
        await this.#enableMainBundles(id)
        // The offer declares everything the main interface has installed;
        // only the enabled ones above are wanted, so the dormant rest goes
        // immediately instead of lingering until the first start prunes it.
        await this.pruneUnenabledThirdParty(id)
        if (offered.length > 0) this.log.info('multiview: sub-interface %s starts with the main interface\'s plugins copied in (%d declared)', id, offered.length)
      } catch (error) {
        this.log.warn('multiview: could not copy plugins into %s (%s); it starts with the official set only', id, String(error))
      }
    }
    if (input.copySessions === true) {
      try {
        const workspace = await this.#firstWorkspacePath(id)
        if (workspace !== undefined) await this.#copySessionsInto(id, workspace.path, workspace.registry)
      } catch (error) {
        this.log.warn('multiview: could not copy sessions into %s (%s); it starts with none', id, String(error))
      }
    }

    const view = new ChildHost({
      id,
      profile: `${this.config.profilePrefix}${id}`,
      runtime,
      cwd: this.home,
      config: this.config,
      log: this.log,
      overlayPath: overlay.overlayPath,
    })
    this.views.set(id, view)
    return { ...view.describe(), chosenWorkspace: chosen }
  }

  /**
   * The first workspace record in a sub-interface's own registry.
   *
   * A creation-time copy targets the workspace the new sub-interface was
   * seeded with; a fresh registry holds exactly one, so "the first" is the
   * operator's choice. Sessions live under a directory keyed by the workspace
   * PATH, and the registry is what maps back from the seed to that path.
   *
   * @param viewId - the sub-interface.
   * @returns the record with its path and registry document, or undefined.
   */
  async #firstWorkspacePath(viewId) {
    const { readFile } = await import('node:fs/promises')
    const { existsSync } = await import('node:fs')
    const file = joinPath(this.dataDir(viewId), 'storages', 'workspace.json')
    if (!existsSync(file)) return undefined
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      const record = Object.values(parsed?.tables?.workspaces ?? {})
        .find((entry) => typeof entry?.path === 'string' && entry.path !== '')
      return record === undefined ? undefined : { path: record.path, registry: parsed }
    } catch {
      return undefined
    }
  }

  /**
   * Copy the main interface's sessions for one workspace into a sub-interface,
   * folding the copied ids into its workspace registry.
   *
   * The file copy is {@link syncSessions}'s, but ownership travels with it: a
   * session whose id is absent from every `sessionIds` list in the
   * sub-interface's registry is appended to the record whose path matches the
   * copy's own project key. Without this, the copied conversations existed on
   * disk but appeared nowhere — `dsh-client-ui-workspace` derives the sidebar
   * from membership, so unowned sessions are invisible.
   *
   * @param viewId - the sub-interface to copy into.
   * @param workspacePath - the workspace directory whose sessions to copy.
   * @param registry - the sub-interface's own registry document, mutated in
   *   memory; persisted here when membership changed.
   * @returns what was copied, kept, and linked into the registry.
   */
  async #copySessionsInto(viewId, workspacePath, registry) {
    const { cp, mkdir, readdir, readFile, writeFile } = await import('node:fs/promises')
    const { existsSync } = await import('node:fs')

    const source = joinPath(this.home, 'sessions', projectKeyOf(workspacePath))
    const target = joinPath(this.dataDir(viewId), 'sessions', projectKeyOf(workspacePath))
    let copied = 0
    let kept = 0
    let reason
    if (!existsSync(source)) {
      reason = 'the main interface has no sessions for that workspace'
    } else {
      await mkdir(target, { recursive: true })
      for (const entry of await readdir(source, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const from = joinPath(source, entry.name)
        const to = joinPath(target, entry.name)
        if (existsSync(to)) {
          kept += 1
          continue
        }
        await cp(from, to, { recursive: true, force: true })
        copied += 1
      }
    }

    // Fold the copied ids into the registry: a session visible only in the
    // store is a session the sidebar never lists. Ownership goes to the
    // workspace record whose path keys the copied directory — the same
    // relation the runtime itself maintains.
    let linked = 0
    if (copied > 0 && registry !== undefined) {
      const records = registry?.tables?.workspaces
      if (typeof records === 'object' && records !== null) {
        const projectKey = projectKeyOf(workspacePath)
        const record = Object.entries(records).find(([, entry]) => typeof entry?.path === 'string' && projectKeyOf(entry.path) === projectKey)?.[1]
        if (record !== undefined) {
          const owned = new Set(record.sessionIds ?? [])
          for (const name of await readdir(target, { withFileTypes: true })) {
            if (!name.isDirectory()) continue
            if (!owned.has(name.name)) {
              owned.add(name.name)
              linked += 1
            }
          }
          record.sessionIds = [...owned]
          const targetRegistry = joinPath(this.dataDir(viewId), 'storages', 'workspace.json')
          try {
            await readFile(targetRegistry, 'utf8')
            await writeFile(targetRegistry, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
          } catch {
            /* the registry vanished mid-copy; the child will still show nothing rather than fail */
          }
        }
      }
    }
    this.log.info(
      'multiview: creation copy for %s — %s session directory(ies) copied (%s kept, %s linked into its registry) from %s',
      viewId, String(copied), String(kept), String(linked), workspacePath,
    )
    return { copied, kept, linked, ...(reason === undefined ? {} : { reason }) }
  }

  /**
   * The workspace records one sub-interface should be seeded with.
   *
   * `undefined` means "seed the whole main registry", which is what a sub-interface
   * with no explicit choice gets (and what an upgrade of an existing
   * sub-interface gets, since re-seeding is skipped once it has a registry).
   *
   * When the caller names a workspace, the result holds **only that record**, so a
   * new sub-interface starts on the directory the operator picked rather than on
   * the main interface's entire list. Naming a `cwd` that is not a registered
   * workspace yields that directory as a fresh record, because "pick a folder"
   * must work for a directory that has never been opened before.
   *
   * @param input - `{ workspaceId?, cwd? }`.
   * @returns the parsed main registry filtered to the choice, or undefined.
   */
  async #resolveSeedWorkspaces(input) {
    const { readFile } = await import('node:fs/promises')
    const { existsSync } = await import('node:fs')
    const workspaceId = typeof input.workspaceId === 'string' && input.workspaceId !== '' ? input.workspaceId : undefined
    const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : undefined
    if (workspaceId === undefined && cwd === undefined) return undefined
    const mainPath = joinPath(this.home, 'storages', 'workspace.json')
    if (!existsSync(mainPath)) return undefined
    let parsed
    try {
      parsed = JSON.parse(await readFile(mainPath, 'utf8'))
    } catch {
      return undefined
    }
    const records = parsed?.tables?.workspaces ?? {}
    if (workspaceId !== undefined) {
      const record = records[workspaceId]
      if (record === undefined) {
        throw new Error(`multiview: workspace ${JSON.stringify(workspaceId)} is not in the workspace registry, so it cannot be the starting workspace`)
      }
      return { unit: { name: 'workspace', version: 2 }, global: {}, tables: { workspaces: { [workspaceId]: record } } }
    }
    // A directory the registry does not own yet: adopt it as a one-record seed.
    const canonical = (value) => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
    const match = Object.entries(records).find(([, record]) => typeof record?.path === 'string' && canonical(record.path) === canonical(cwd))
    if (match !== undefined) {
      return { unit: { name: 'workspace', version: 2 }, global: {}, tables: { workspaces: { [match[0]]: match[1] } } }
    }
    const now = new Date().toISOString()
    return {
      unit: { name: 'workspace', version: 2 },
      global: {},
      tables: { workspaces: { [randomUUID()]: { path: cwd, title: cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd, sessionIds: [], createdAt: now, updatedAt: now } } },
    }
  }

  /**
   * Register the caller's chosen workspace inside a freshly seeded sub-interface.
   *
   * Seeding already writes the record, so this only has to cover the case where a
   * seed was skipped or the choice was a bare directory: it asks the running child
   * to adopt the path, which is idempotent. It runs after the child is up, so it
   * is scheduled rather than awaited by `open` — a caller inspecting the response
   * should not have to wait for a child boot.
   *
   * @param viewId - the sub-interface.
   * @param input - `{ workspaceId?, cwd? }`.
   * @returns the workspace id the sub-interface starts on, when one was chosen.
   */
  async #registerChosenWorkspace(viewId, input) {
    const workspaceId = typeof input.workspaceId === 'string' && input.workspaceId !== '' ? input.workspaceId : undefined
    const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : undefined
    if (workspaceId === undefined && cwd === undefined) return undefined
    return workspaceId ?? cwd
  }

  /**
   * Make the main profile's third-party plugins available to a sub-interface,
   * switched off.
   *
   * A sub-interface's profile is initialized from the shipped `web` template,
   * which contains the official bundles only. The main profile may have
   * community plugins the operator would want here too, but enabling them
   * automatically would defeat the point of separate profiles -- a plugin that
   * breaks a sub-interface should not be forced on it, and a sub-interface
   * should not silently acquire capabilities its operator never chose.
   *
   * So the packages are made *resolvable* and listed as dependencies, while
   * `dsh.profile.bundles` -- which is what actually switches a bundle on -- is
   * left alone. The sub-interface's own plugin page then lists them as installed
   * and disabled, and the operator enables the ones that sub-interface needs.
   *
   * Official packages are skipped: the template already carries them.
   *
   * @param viewId - the sub-interface whose profile to extend.
   * @returns the package names that were made available.
   */
  async #offerThirdPartyBundles(viewId) {
    const { readFile, writeFile, mkdir, symlink, lstat, realpath } = await import('node:fs/promises')
    const { join, dirname } = await import('node:path')
    const { existsSync } = await import('node:fs')
    const { createRequire } = await import('node:module')

    const profileName = (name) => `${this.config.profilePrefix}${name}`
    const mainDir = this.mainPatchPath === undefined ? undefined : dirname(this.mainPatchPath)
    if (mainDir === undefined) return []
    const mainManifestPath = join(mainDir, 'package.json')
    const childDir = join(this.home, 'profiles', profileName(viewId))
    const childManifestPath = join(childDir, 'package.json')
    if (!existsSync(mainManifestPath) || !existsSync(childManifestPath)) return []

    let main
    let child
    try {
      main = JSON.parse(await readFile(mainManifestPath, 'utf8'))
      child = JSON.parse(await readFile(childManifestPath, 'utf8'))
    } catch (error) {
      this.log.warn('multiview: could not read a profile manifest (%s); the sub-interface keeps the official plugin set', String(error))
      return []
    }

    // Where a package really is, asked the way Node asks. A dependency directory
    // can exist and still hold nothing -- a hoisted or partially materialized
    // install leaves a placeholder -- and linking that would hand the child a
    // bundle it cannot load. Linking is therefore best-effort: the declaration
    // below is what makes the plugin visible to the sub-interface, and the link
    // is what makes it loadable without a network install.
    const resolveMain = createRequire(mainManifestPath)
    const realPathOf = async (name) => {
      try {
        return await realpath(dirname(resolveMain.resolve(`${name}/package.json`)))
      } catch {
        return undefined
      }
    }

    const mainDependencies = main?.dependencies ?? {}
    const childDependencies = { ...(child.dependencies ?? {}) }
    const official = (name) => name.startsWith('@deepseek-ai/')

    /**
     * Whether a dependency spec resolves on any machine.
     *
     * `link:`, `file:`, `workspace:` and bare paths point at one installation's
     * directory layout. Copying one into a sub-interface's manifest would hand
     * that profile a dependency it can never install — the failure surfaces much
     * later, as a confusing install error inside the sub-interface. Such packages
     * are therefore skipped, and the operator is told why.
     */
    const portableSpec = (spec) => {
      if (typeof spec !== 'string') return false
      const value = spec.trim()
      if (value === '') return false
      if (/^(?:link|file|workspace|portal):/i.test(value)) return false
      if (value.startsWith('.') || value.startsWith('/') || value.startsWith('\\')) return false
      if (/^[a-zA-Z]:[\\/]/.test(value)) return false
      return true
    }

    const offered = []
    const unlinked = []
    const skipped = []
    /** Links created into the main profile, recorded so cleanup can undo them. @type {{name: string, target: string}[]} */
    const linked = []
    for (const [name, spec] of Object.entries(mainDependencies)) {
      // Official packages come from the template; this plugin is the thing doing
      // the offering and must never offer itself (that would recurse).
      if (official(name) || name === 'dsh-multiview') continue
      if (childDependencies[name] !== undefined) continue
      if (!portableSpec(spec)) {
        skipped.push(`${name} (${String(spec)})`)
        continue
      }

      childDependencies[name] = spec
      offered.push(name)

      const source = await realPathOf(name)
      if (source === undefined) {
        unlinked.push(name)
        continue
      }

      // Make the package resolvable in the child profile. A directory link is
      // enough and avoids a network install; it points at the copy the main
      // profile itself loads, so the version matches the manifest.
      const linkPath = join(childDir, 'node_modules', name)
      try {
        await mkdir(dirname(linkPath), { recursive: true })
        const existingLink = await lstat(linkPath).catch(() => undefined)
        if (existingLink === undefined) {
          await symlink(source, linkPath, 'junction')
          linked.push({ name, target: source })
        } else if (existingLink.isSymbolicLink()) {
          // Already offered by an earlier start; the target is checked above.
          linked.push({ name, target: source })
        } else {
          // A real directory is the operator's own install; leave it alone.
          this.log.info('multiview: %s already has a real %s; leaving it in place', viewId, name)
        }
      } catch (error) {
        unlinked.push(name)
        this.log.warn('multiview: could not link %s into %s (%s)', name, profileName(viewId), String(error))
      }
    }

    // Write down what was linked, because these links point INTO the main
    // profile's own package copies — and a recursive delete that walks a link
    // deletes the target, not the link. `fs.rmSync(dir, { recursive: true })`
    // does exactly that on Windows, and an operator cleaning up a sub-interface
    // directory has no other way to know which entries are links. Anything that
    // deletes this profile should unlink these first.
    if (linked.length > 0) {
      await writeFile(join(childDir, '.multiview-links.json'), `${JSON.stringify({
        note: 'These node_modules entries are links into another profile. Unlink them before deleting this directory recursively, or the delete will follow them into the main profile.',
        view: viewId,
        links: linked,
      }, null, 2)}\n`, 'utf8')
    }

    if (skipped.length > 0) {
      this.log.warn(
        'multiview: sub-interface %s was not offered %s: %s resolves only on the machine that installed it, so it cannot be declared in another profile',
        viewId, skipped.map((entry) => entry.split(' (')[0]).join(', '), skipped.join(' / '),
      )
    }
    if (unlinked.length > 0) {
      this.log.warn(
        'multiview: sub-interface %s lists %s as available, but their files could not be found in the main profile, so they will not load until installed here. Open the sub-interface\'s plugin page to install them.',
        viewId, unlinked.join(', '),
      )
    }
    if (offered.length === 0) return []

    // Deliberately NOT touching `dsh.profile.bundles`: a bundle is enabled by
    // being listed there, and the whole point is to leave these off.
    child.dependencies = childDependencies
    await writeFile(childManifestPath, `${JSON.stringify(child, null, 2)}\n`, 'utf8')
    this.log.info(
      'multiview: sub-interface %s can now enable %d third-party plugin(s) from its own plugin page: %s',
      viewId, offered.length, offered.join(', '),
    )
    return offered
  }

  /**
   * Register the exact WebSocket upgrade route a child's Remote stream socket
   * needs. `registerUpgrade` matches exact pathnames only, so one route is
   * registered per running sub-interface and released when it stops.
   */
  #registerUpgradeRoute(id) {
    if (this.upgradeRoutes.has(id)) return
    const path = `${ROUTE_PREFIX}/${id}/${STREAM_PATH}`
    const dispose = this.ctx.webServer.registerUpgrade({
      path,
      handler: (req, socket, head) => {
        // The Remote stream carries the same credentials as the mount: the
        // desktop shell rewrites the `ws://127.0.0.1/*` handshake and attaches
        // the host cookie, and a browser window sends its own session cookie on
        // a same-origin upgrade. Anything else is refused before a byte is sent.
        if (!this.admitsMount(req, id)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
          socket.destroy()
          return
        }
        const target = this.target(id)
        if (target === undefined) {
          socket.destroy()
          return
        }
        void import('node:net').then(({ connect }) => {
          const upstream = new URL(target.origin)
          const upstreamSocket = connect(Number(upstream.port), upstream.hostname, () => {
            const headers = [
              `GET /${STREAM_PATH} HTTP/1.1`,
              `Host: ${upstream.host}`,
              'Upgrade: websocket',
              'Connection: Upgrade',
              `Sec-WebSocket-Key: ${String(req.headers['sec-websocket-key'] ?? '')}`,
              `Sec-WebSocket-Version: ${String(req.headers['sec-websocket-version'] ?? '13')}`,
              `Origin: ${target.origin}`,
              `Cookie: ${target.cookie}`,
            ]
            const protocol = req.headers['sec-websocket-protocol']
            if (typeof protocol === 'string' && protocol !== '') headers.push(`Sec-WebSocket-Protocol: ${protocol}`)
            headers.push('', '')
            upstreamSocket.write(headers.join('\r\n'))
            if (head !== undefined && head.length > 0) upstreamSocket.write(head)
            socket.pipe(upstreamSocket)
            upstreamSocket.pipe(socket)
          })
          const fail = () => {
            upstreamSocket.destroy()
            socket.destroy()
          }
          upstreamSocket.on('error', fail)
          socket.on('error', fail)
        }).catch(() => { socket.destroy() })
      },
    })
    this.upgradeRoutes.set(id, dispose)
  }

  #releaseUpgradeRoute(id) {
    const dispose = this.upgradeRoutes.get(id)
    if (dispose === undefined) return
    this.upgradeRoutes.delete(id)
    try {
      dispose()
    } catch {
      /* already gone */
    }
  }

  /** Start a sub-interface's child host and return its proxied base path. */
  async start(id) {
    const view = this.views.get(id)
    if (view === undefined) throw new Error(`multiview: unknown sub-interface ${JSON.stringify(id)}`)
    if (!this.config.autoStart) throw new Error('multiview: automatic sub-interface start is disabled by configuration')
    // Re-mirror the model configuration before booting: the main interface's
    // selection may have moved while this sub-interface was stopped, and the
    // overlay is read once at process start.
    //
    // Third-party leakage is REVERSED here. Earlier builds offered the main
    // interface's third-party packages into every sub-interface on every
    // start (declared, dormant, visible in its plugin page) so an old profile
    // could enable them by hand. That is not what creation means any more: a
    // sub-interface shows third-party plugins only after an explicit copy
    // (the creation checkbox or the 插件 sync action), and anything still
    // dormant from the old behaviour is pruned on every start.
    await this.pruneUnenabledThirdParty(id)
    const overlay = await this.syncModelConfiguration(id)
    view.overlayPath = overlay.overlayPath
    const basePath = await view.start()
    this.#registerUpgradeRoute(id)
    // Put the child back on the workspace it was last working in: without this
    // a restarted client lands on whichever workspace its sidebar sorts first,
    // which read as "重新打开 jumped to another workspace".
    await this.restoreCurrentWorkspace(id)
    return { id, basePath, state: view.state }
  }

  /** Stop a child host but keep its tab and profile. */
  async stop(id) {
    const view = this.views.get(id)
    if (view === undefined) return { id, state: 'stopped' }
    this.#releaseUpgradeRoute(id)
    await view.stop()
    // A browser window is only a client of that host; keeping it open would
    // leave a window pointed at a backend that is gone.
    this.closeWindows(id)
    return { id, state: view.state }
  }

  /** Close a sub-interface: stop its host and forget it; its profile survives. */
  async close(id) {
    const view = this.views.get(id)
    if (view === undefined) return { id, closed: true }
    this.#releaseUpgradeRoute(id)
    await view.stop()
    this.closeWindows(id)
    this.views.delete(id)
    // The current-workspace memory KEEPS surviving a close on purpose: it is
    // what lets a later 打开 land back where the operator was. Only a reset
    // (removeView) erases it, together with the profile itself.
    return { id, closed: true }
  }

  /**
   * Reset a sub-interface: stop it, close its windows, and delete its profile.
   *
   * `close` keeps the profile (that is what makes a closed tab recoverable), and
   * the profile is where an installed plugin set and its `node_modules` live —
   * so this is the operation that actually reclaims the disk. It is also the
   * **only** supported way to delete one, because the teardown has to unlink the
   * profile's links before the recursive delete (see
   * {@link removeProfileDirectory}). It works for an id with no live view, which
   * is what resetting a closed tab needs.
   *
   * @param id - the sub-interface id.
   * @returns what was removed, links included.
   */
  async removeView(id) {
    await this.resolveRuntime()
    const { join } = await import('node:path')
    const view = this.views.get(id)
    if (view !== undefined) {
      this.#releaseUpgradeRoute(id)
      await view.stop()
      this.views.delete(id)
    }
    this.closeWindows(id)
    // The profile is gone — the workspace memory refers to a sub-interface
    // that no longer exists, so it goes with it.
    this.currentWorkspaces.delete(id)
    const profile = `${this.config.profilePrefix}${id}`
    const directory = join(this.home, 'profiles', profile)
    const result = await removeProfileDirectory(directory, this.config.profilePrefix)
    this.log.info(
      'multiview: reset sub-interface %s (profile removed=%s, links unlinked=%s)',
      id, String(result.removed), String(result.links),
    )
    return { id, profile, directory, ...result }
  }

  /**
   * The directory holding one sub-interface's isolated stores.
   *
   * It lives inside the sub-interface's own profile so it shares that profile's
   * lifecycle: {@link removeView} already deletes the profile safely (unlinking
   * links first), so isolated data can never be orphaned, and a profile reset
   * takes the data with it.
   *
   * @param viewId - the sub-interface id.
   * @returns the absolute directory (which may not exist yet).
   */
  dataDir(viewId) {
    return joinPath(this.home, 'profiles', `${this.config.profilePrefix}${viewId}`, this.config.dataDirName)
  }

  /**
   * The persisted favorites file (常用收藏清单).
   *
   * Favorites used to live in each window's localStorage — which meant the
   * main window and every independent-mode browser window kept SEPARATE
   * lists. Storing them here, in `$DSH_HOME`, makes the list shared: every
   * window's settings page reads and writes the same file through /mv/api.
   *
   * Format: `{ favorites: [id, ...] }`. A missing or corrupt file simply
   * means "no favorites yet"; every write rewrites the whole file.
   */
  favoritesFile() {
    return joinPath(this.home, 'multiview', 'favorites.json')
  }

  /** The persisted favorite ids, or an empty list. */
  async readFavorites() {
    try {
      const { readFile } = await import('node:fs/promises')
      const parsed = JSON.parse(await readFile(this.favoritesFile(), 'utf8'))
      return Array.isArray(parsed?.favorites) ? parsed.favorites.filter((id) => typeof id === 'string') : []
    } catch {
      return []
    }
  }

  /** Persist the favorite ids (whole-file rewrite; small list, atomic enough). */
  async writeFavorites(ids) {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    const file = this.favoritesFile()
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify({ favorites: ids }, null, 2)}\n`, 'utf8')
  }

  /** The shared favorite list. */
  async listFavorites() {
    return { favorites: await this.readFavorites() }
  }

  /** Add or remove one id from the shared favorite list. */
  async toggleFavorite(id) {
    const current = await this.readFavorites()
    const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
    await this.writeFavorites(next)
    return { favorites: next, added: !current.includes(id) }
  }

  /**
   * Seed a sub-interface's isolated workspace registry from the main one.
   *
   * A sub-interface with its own `storages` root boots with an empty registry,
   * and nothing fills it afterwards: creating a session by `cwd` does not
   * register the directory, and the runtime's own default-workspace bootstrap
   * does not fire for this shape. Without a seed every sub-interface would show a
   * permanently empty sidebar, which reads as "broken" rather than "new".
   *
   * Seeding happens only when the sub-interface has no registry yet. Re-seeding
   * on every start would resurrect workspaces the operator removed and undo
   * their own edits, which is the opposite of isolation.
   *
   * @param viewId - the sub-interface id.
   * @param only - a pre-filtered registry document to seed FROM instead of the main
   *   one. Used when the caller chose a single starting workspace; the shape is
   *   the same as `workspace.json`, and its records are copied through the same
   *   session-stripping path.
   * @param force - seed even when a registry already exists. Used by the explicit
   *   "copy the main workspaces over" action, where replacing is the request.
   * @returns whether a registry was written, and how many workspaces it holds.
   */
  async seedWorkspaces(viewId, only, force = false) {
    const { mkdir, readFile, writeFile } = await import('node:fs/promises')
    const { existsSync } = await import('node:fs')
    const dir = this.dataDir(viewId)
    const target = joinPath(dir, 'storages', 'workspace.json')
    if (!force && existsSync(target)) return { seeded: false, reason: 'the sub-interface already has its own registry' }
    let parsed = only
    if (parsed === undefined) {
      const mainPath = joinPath(this.home, 'storages', 'workspace.json')
      if (!existsSync(mainPath)) return { seeded: false, reason: 'the main interface has no workspace registry to copy' }
      try {
        parsed = JSON.parse(await readFile(mainPath, 'utf8'))
      } catch (error) {
        return { seeded: false, reason: `the main workspace registry is unreadable (${String(error)})` }
      }
    }
    const document = seedWorkspaceRegistry(parsed)
    if (document === undefined) return { seeded: false, reason: 'the source registry holds no workspaces' }
    await mkdir(joinPath(dir, 'storages'), { recursive: true })
    await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    const count = Object.keys(document.tables.workspaces).length
    this.log.info('multiview: seeded %s workspace(s) into sub-interface %s', String(count), viewId)
    return { seeded: true, workspaces: count, path: target }
  }

  /**
   * Clear the CURRENT workspace's sessions of one sub-interface, keeping its
   * profile, plugins, and the rest of its workspace list.
   *
   * The operator's semantics (explicitly requested): 清空会话 = archive the
   * sessions of the workspace they are IN, then reopen that same workspace —
   * not "wipe every store and reseed the whole main list", which yanked the
   * child to a different workspace after the restart.
   *
   * So this stops the child, deletes the session DIRECTORY of the recorded
   * current workspace inside the child's own isolated store (its sessions live
   * under a name derived from the workspace path), and restarts it — the
   * restore pass in `start` then lands it back on that workspace, with a fresh
   * empty session there. Everything else (other workspaces' sessions, the
   * registry, plugins, configuration) is untouched.
   *
   * @param id - the sub-interface id.
   * @returns what was cleared and how the reopen went.
   */
  async clearViewData(id) {
    const { rm } = await import('node:fs/promises')
    const { existsSync } = await import('node:fs')
    const view = this.views.get(id)
    if (view !== undefined) {
      this.#releaseUpgradeRoute(id)
      // `stop` clears the spawn memo, so the next start spawns a real host and
      // re-reads the (now trimmed) stores.
      await view.stop()
      this.closeWindows(id)
    }

    const record = this.currentWorkspaces.get(id)
    let clearedDir
    let cleared = false
    if (record !== undefined && typeof record.cwd === 'string' && record.cwd !== '') {
      // The child's own session store keys directories by workspace path.
      const dir = joinPath(this.dataDir(id), 'sessions', projectKeyOf(record.cwd))
      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true })
        cleared = true
        clearedDir = dir
      }
    } else {
      // No memory of a current workspace (e.g. created before this existed):
      // fall back to clearing ALL of the child's session store, as before.
      const dir = joinPath(this.dataDir(id), 'sessions')
      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true })
        cleared = true
        clearedDir = dir
      }
    }
    this.log.info('multiview: cleared sessions of sub-interface %s (cleared=%s, dir=%s)', id, String(cleared), String(clearedDir ?? 'none'))
    return { id, cleared, directory: clearedDir, workspace: record?.cwd }
  }

  /**
   * Duplicate a sub-interface into a new one.
   *
   * The copy starts from the source's *plugin set and configuration* — that is
   * what makes duplicating useful — but gets its own profile directory and its
   * own isolated stores, so the two share no state afterwards. The source is not
   * touched and does not need to be running.
   *
   * `node_modules` is deliberately not copied: it is a directory of junctions
   * into the main profile, and copying it is the operation that has twice emptied
   * the main profile's plugins. Links are re-established by the third-party
   * offering instead.
   *
   * @param sourceId - the sub-interface to copy.
   * @param newId - the id for the copy; derived from the source when omitted.
   * @returns the new sub-interface's description.
   */
  async duplicateView(sourceId, newId) {
    const { cp, existsSync } = await import('node:fs/promises')
    const { existsSync: existsSyncSync } = await import('node:fs')
    await this.resolveRuntime()

    const sourceDir = joinPath(this.home, 'profiles', `${this.config.profilePrefix}${sourceId}`)
    if (!existsSyncSync(joinPath(sourceDir, 'package.json'))) {
      throw new Error(`multiview: sub-interface ${JSON.stringify(sourceId)} has no profile to copy`)
    }

    let id = typeof newId === 'string' && newId !== '' ? newId : undefined
    if (id === undefined) {
      id = `${sourceId}-copy`
      let suffix = 2
      while (this.views.has(id) || existsSyncSync(joinPath(this.home, 'profiles', `${this.config.profilePrefix}${id}`, 'package.json'))) {
        id = `${sourceId}-copy${String(suffix)}`
        suffix += 1
      }
    }
    if (RESERVED_IDS.has(id)) throw new Error(`multiview: sub-interface ${JSON.stringify(id)} is a reserved id`)
    if (this.views.has(id)) throw new Error(`multiview: sub-interface ${JSON.stringify(id)} already exists`)
    if (this.views.size >= this.config.maxViews) {
      throw new Error(`multiview: at most ${String(this.config.maxViews)} sub-interfaces may run at once`)
    }

    // FULL CLONE. The operator's semantics for 复制打开: the copy is the same
    // sub-interface with a different name — plugins, sessions, workspace list,
    // plugin running mode, everything. The profile directory carries all of
    // that, so the copy is the directory copied WHOLE (minus `node_modules`,
    // which is a nest of junctions into the MAIN profile's package copies and
    // must never be walked; the third-party offering re-links the copy's own).
    // Isolated stores (multiview-data) come along inside it, so sessions and
    // the workspace list travel with the clone.
    const targetDir = joinPath(this.home, 'profiles', `${this.config.profilePrefix}${id}`)
    await this.ensureProfile(id)
    await cp(sourceDir, targetDir, {
      recursive: true,
      force: true,
      filter: (from) => {
        // Never copy the junction farm, never copy the spawn memo.
        const base = from.split(/[\\/]/).pop()
        return base !== 'node_modules' && base !== 'cordis.yml'
      },
    })
    // The manifest must name the NEW profile, not the old one.
    try {
      const { readFile: readFileFn, writeFile: writeFileFn } = await import('node:fs/promises')
      const parsed = JSON.parse(await readFileFn(joinPath(targetDir, 'package.json'), 'utf8'))
      parsed.name = `dsh-profile-${this.config.profilePrefix}${id}`
      await writeFileFn(joinPath(targetDir, 'package.json'), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
    } catch (error) {
      this.log.warn('multiview: could not rename the cloned manifest for %s (%s)', id, String(error))
    }

    // The clone's own third-party packages were declared by the copied
    // manifest; re-link them into the clone's node_modules so they resolve.
    await this.#offerThirdPartyBundles(id)
    // Enable whatever the SOURCE has enabled (the copied manifest already
    // carries those bundle entries — this is a no-op safeguard), then prune
    // dormant leftovers exactly as every start does.
    await this.#enableMainBundles(id)
    await this.pruneUnenabledThirdParty(id)
    const overlay = await this.syncModelConfiguration(id)

    // The clone inherits the source's running mode AND current workspace, so
    // it opens exactly where and how the source was.
    const sourceMode = this.pluginModes?.get(sourceId)
    if (sourceMode !== undefined) {
      this.pluginModes ??= new Map()
      this.pluginModes.set(id, sourceMode)
    }
    const sourceWorkspace = this.currentWorkspaces.get(sourceId)
    if (sourceWorkspace !== undefined) this.currentWorkspaces.set(id, { ...sourceWorkspace })

    const view = new ChildHost({
      id,
      profile: `${this.config.profilePrefix}${id}`,
      runtime: this.runtime,
      cwd: this.home,
      config: this.config,
      log: this.log,
      overlayPath: overlay.overlayPath,
    })
    this.views.set(id, view)
    this.log.info('multiview: duplicated sub-interface %s as %s (full clone)', sourceId, id)
    return { ...view.describe(), source: sourceId }
  }

  /**
   * Copy the main interface's plugin set into a sub-interface, enabled.
   *
   * The counterpart of the creation-time offering: this is the action a
   * sub-interface's operator runs when it needs what the main interface
   * already has. Packages become declared dependencies (linked into the main
   * profile's copies), and — unlike the creation-time offering, which leaves
   * everything switched off — every package the MAIN interface currently has
   * enabled in `dsh.profile.bundles` is enabled here too. The sub-interface
   * starts with a working copy of the main interface's plugin set rather than
   * a dormant list it must enable by hand.
   *
   * Isolation is untouched: the copy lives in the sub-interface's own profile,
   * so enabling, disabling, installing or removing anything there never
   * reaches the main interface, and the main interface's later changes are
   * only picked up by running this action again.
   *
   * A live child must restart to load a newly enabled bundle (bundles are read
   * once at boot), so the child is stopped before the write and restarted
   * after — one operation in the UI, and the frame reloads against the new
   * process.
   *
   * @param id - the sub-interface to copy into.
   * @returns what was offered, enabled, skipped, and already present.
   */
  async syncPlugins(id) {
    const view = this.views.get(id)
    if (view !== undefined) {
      // Bundles are read once at boot, so a live child must restart for a
      // newly enabled bundle to load. Stop BEFORE writing: the freshly enabled
      // bundle is then picked up by the restart below, not half-applied.
      this.#releaseUpgradeRoute(id)
      await view.stop()
      this.closeWindows(id)
    }

    const offered = await this.#offerThirdPartyBundles(id)
    const enabled = await this.#enableMainBundles(id)
    // The offer declares everything the main interface has installed; only
    // the enabled ones above are wanted, so the dormant rest does not linger
    // in the sub-interface's plugin page after the copy.
    await this.pruneUnenabledThirdParty(id)

    const { readFile } = await import('node:fs/promises')
    const manifestPath = joinPath(this.home, 'profiles', `${this.config.profilePrefix}${id}`, 'package.json')
    let installed = []
    let active = []
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      installed = Object.keys(manifest.dependencies ?? {})
      active = manifest.dsh?.profile?.bundles ?? []
    } catch {
      /* the caller gets the offered list and nothing else */
    }
    // A restart here is what makes the enabled bundles actually load: without
    // it the copy would only take effect on the next manual "重新打开".
    if (view !== undefined) await this.start(id)
    return { id, offered, enabled, added: offered.length, installed, active, restarted: view !== undefined }
  }

  /**
   * Enable the main interface's currently enabled third-party bundles in a
   * sub-interface.
   *
   * The sub-interface's manifest is authoritative for what it *can* load —
   * {@link #offerThirdPartyBundles} declares and links the packages — while
   * the MAIN profile's manifest is authoritative for what the main interface
   * *has* enabled right now. Copying the second onto the first, package by
   * package, is what makes "复制主界面插件" produce a working copy instead of
   * a dormant list.
   *
   * The main interface's own multiview row is never copied: the sub-interface
   * is a client of the main host, and loading a supervisor inside it would be
   * a supervisor inside a supervisor.
   *
   * @param id - the sub-interface whose manifest to enable into.
   * @returns the package names this call enabled (already-enabled ones included).
   */
  async #enableMainBundles(id) {
    const { readFile, writeFile } = await import('node:fs/promises')
    const { existsSync } = await import('node:fs')
    const { dirname } = await import('node:path')

    const mainDir = this.mainPatchPath === undefined ? undefined : dirname(this.mainPatchPath)
    if (mainDir === undefined) return []
    const childDir = joinPath(this.home, 'profiles', `${this.config.profilePrefix}${id}`)
    const childManifestPath = joinPath(childDir, 'package.json')
    if (!existsSync(childManifestPath)) return []

    let main
    let child
    try {
      main = JSON.parse(await readFile(joinPath(mainDir, 'package.json'), 'utf8'))
      child = JSON.parse(await readFile(childManifestPath, 'utf8'))
    } catch (error) {
      this.log.warn('multiview: could not read a profile manifest (%s); the sub-interface keeps its own bundle switches', String(error))
      return []
    }

    const mainEnabled = new Set(main?.dsh?.profile?.bundles ?? [])
    const childBundles = [...(child?.dsh?.profile?.bundles ?? [])]
    const childDependencies = new Set(Object.keys(child?.dependencies ?? {}))
    const enabled = []
    for (const name of mainEnabled) {
      // Only third-party packages are copied. Official bundles come from the
      // template already, and multiview itself must never load inside a
      // sub-interface (see above).
      if (name.startsWith('@deepseek-ai/') || name === 'dsh-multiview') continue
      // Enabling an undeclared dependency would name a bundle the child
      // cannot resolve — the launcher reports skipped bundles, which is the
      // polite failure — but the operator asked for a working copy, so the
      // offer runs first and anything still unresolved is skipped loudly.
      if (!childDependencies.has(name)) {
        this.log.warn(
          'multiview: sub-interface %s cannot enable %s: it is not resolvable there (its declaration was skipped or failed); enable it manually after installing it in that sub-interface',
          id, name,
        )
        continue
      }
      if (!childBundles.includes(name)) childBundles.push(name)
      enabled.push(name)
    }
    if (enabled.length === 0) return []

    child.dsh ??= {}
    child.dsh.profile ??= {}
    child.dsh.profile.bundles = childBundles
    await writeFile(childManifestPath, `${JSON.stringify(child, null, 2)}\n`, 'utf8')
    this.log.info('multiview: enabled %d third-party bundle(s) in sub-interface %s: %s', enabled.length, id, enabled.join(', '))
    return enabled
  }

  /**
   * Remove third-party packages a sub-interface declares but does not enable.
   *
   * Earlier builds offered the main interface's third-party packages into
   * every sub-interface on every start — declared in its manifest and linked
   * into its `node_modules`, but switched off — so they would show up in the
   * plugin page "ready to enable". That visibility is exactly the leak this
   * file now exists to prevent: a sub-interface must not display third-party
   * plugins until an explicit copy brings them in.
   *
   * So every start, a package that is
   *
   *   - third-party (not `@deepseek-ai/*`, not this plugin),
   *   - declared in the sub-interface's dependencies,
   *   - NOT enabled in its `dsh.profile.bundles`, and
   *   - absent from the sub-interface's own patch layer,
   *
   * is un-declared and its link removed. The patch-layer check is the
   * operator's escape hatch: a package they installed into that sub-interface
   * deliberately (even while keeping it off) carries a row there and survives.
   * Only the dormant traces of the old auto-offer — packages with no row of
   * their own — are cleaned up.
   *
   * The ledger is rewritten to match, so a later profile delete unlinks
   * exactly what remains.
   *
   * @param id - the sub-interface to prune.
   * @returns the package names that were removed.
   */
  async pruneUnenabledThirdParty(id) {
    const { readFile, writeFile, lstat, unlink } = await import('node:fs/promises')
    const { existsSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')

    const childDir = joinPath(this.home, 'profiles', `${this.config.profilePrefix}${id}`)
    const manifestPath = joinPath(childDir, 'package.json')
    if (!existsSync(manifestPath)) return []

    let manifest
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch {
      return []
    }
    const dependencies = { ...(manifest?.dependencies ?? {}) }
    const bundles = manifest?.dsh?.profile?.bundles ?? []
    const enabled = new Set(bundles)

    // The child's own patch layer names the rows its operator actually
    // declared there; a package carrying one is theirs, whatever its switch.
    const ownRowIds = new Set()
    try {
      const patchText = await readFile(joinPath(childDir, 'cordis.patch.yml'), 'utf8')
      for (const block of splitPatchEntries(patchText)) {
        const rowId = entryId(block)
        if (rowId !== undefined) ownRowIds.add(rowId)
      }
    } catch {
      /* no user layer: every third-party declaration below is a leftover */
    }

    // The current links ledger: pruned names leave it, kept names stay.
    let ledger = undefined
    try {
      ledger = JSON.parse(await readFile(joinPath(childDir, '.multiview-links.json'), 'utf8'))
    } catch {
      /* no ledger; one will be written only if links are removed */
    }

    const removed = []
    for (const name of Object.keys(dependencies)) {
      if (name.startsWith('@deepseek-ai/')) continue
      if (name === 'dsh-multiview') continue
      if (enabled.has(name)) continue
      if (ownRowIds.has(name)) continue
      delete dependencies[name]
      removed.push(name)
      // Remove the link this plugin created, never following it: `lstat`
      // sees the link itself, so the main profile's copy is untouched. A
      // real directory there is the operator's own install and stays.
      const linkPath = join(childDir, 'node_modules', name)
      try {
        const stats = await lstat(linkPath)
        if (stats.isSymbolicLink()) await unlink(linkPath)
      } catch {
        /* nothing at that path: the declaration was linkless */
      }
      this.log.info('multiview: pruned dormant third-party declaration %s from sub-interface %s', name, id)
    }
    if (removed.length === 0) return []

    manifest.dependencies = dependencies
    if (Array.isArray(ledger?.links) && ledger.links.length > 0) {
      const kept = ledger.links.filter((link) => typeof link?.name === 'string' && dependencies[link.name] !== undefined && !removed.includes(link.name))
      if (kept.length === 0) {
        try { await unlink(joinPath(childDir, '.multiview-links.json')) } catch { /* already gone */ }
      } else {
        ledger.links = kept
        await writeFile(joinPath(childDir, '.multiview-links.json'), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
      }
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    this.log.info('multiview: pruned %d dormant third-party declaration(s) from sub-interface %s: %s', removed.length, id, removed.join(', '))
    return removed
  }

  /**
   * Copy the main interface's workspaces into a sub-interface.
   *
   * This **replaces** the sub-interface's workspace registry with a fresh copy of
   * the main one (session ownership emptied, like every seed). Merge was the
   * alternative and was rejected: the registry has an authoritative display order
   * and a one-owner-per-session invariant, and merging two of them leaves no
   * defensible answer for "which order" or for a workspace the operator deleted
   * here on purpose. Replacing is a stated, predictable outcome.
   *
   * Sessions are not carried over — a session lives in the session store, which is
   * a separate action ({@link syncSessions}).
   *
   * @param id - the sub-interface to copy into.
   * @returns how many workspaces the registry holds afterwards.
   */
  async syncWorkspaces(id) {
    const view = this.views.get(id)
    if (view !== undefined) {
      // The registry is read once at boot, so a live child must be restarted for
      // the new one to take effect. Restarting here is what makes the action feel
      // like one operation in the UI.
      this.#releaseUpgradeRoute(id)
      await view.stop()
      this.closeWindows(id)
    }
    const seeded = await this.seedWorkspaces(id, undefined, true)
    if (view !== undefined) await this.start(id)
    return { id, ...seeded }
  }

  /**
   * Copy the main interface's sessions for one workspace into a sub-interface.
   *
   * Sessions live under a directory named for the **workspace path** (not for the
   * profile), so they are copied outright: the encoding below is the runtime's own
   * (`projectKey` in `dsh-session-persistence-jsonl`), which is what makes the
   * sub-interface find them where it looks.
   *
   * Only the chosen workspace's directory is copied. Copying every workspace's
   * sessions would drag in conversations for directories this sub-interface does
   * not even list, and it is unbounded in a way a per-workspace action is not.
   *
   * Existing session directories are left alone unless `overwrite` is set: a
   * session id is unique, so a copied id that already exists here is the same
   * conversation, and re-copying it could overwrite a longer local history.
   *
   * @param id - the sub-interface to copy into.
   * @param workspacePath - absolute directory whose sessions to copy.
   * @param overwrite - replace session directories that already exist.
   * @returns how many session directories were copied and how many were kept.
   */
  async syncSessions(id, workspacePath, overwrite = false) {
    const { cp, mkdir, readdir, stat } = await import('node:fs/promises')
    const { existsSync } = await import('node:fs')
    const path = typeof workspacePath === 'string' && workspacePath !== '' ? workspacePath : undefined
    if (path === undefined) throw new Error('multiview: syncing sessions needs the workspace whose sessions to copy')

    const view = this.views.get(id)
    if (view !== undefined) {
      // The session store is read once at boot for the header index, so a live
      // child is restarted to pick the copied sessions up.
      this.#releaseUpgradeRoute(id)
      await view.stop()
      this.closeWindows(id)
    }

    const source = joinPath(this.home, 'sessions', projectKeyOf(path))
    const target = joinPath(this.dataDir(id), 'sessions', projectKeyOf(path))
    let copied = 0
    let kept = 0
    let reason
    if (!existsSync(source)) {
      reason = 'the main interface has no sessions for that workspace'
    } else {
      await mkdir(target, { recursive: true })
      for (const entry of await readdir(source, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const from = joinPath(source, entry.name)
        const to = joinPath(target, entry.name)
        if (existsSync(to) && !overwrite) {
          kept += 1
          continue
        }
        await cp(from, to, { recursive: true, force: true })
        copied += 1
      }
    }

    if (view !== undefined) await this.start(id)
    this.log.info('multiview: copied %s session(s) into %s for %s (%s kept)', String(copied), id, path, String(kept))
    return { id, workspace: path, source, target, copied, kept, ...(reason === undefined ? {} : { reason }) }
  }

  /**
   * The main interface's workspace list, in registry display order.
   *
   * Read straight from the registry document rather than through the main host's
   * own RPC: the plugin is a Host-side row in the same process, and the registry is
   * the authority the sidebar itself renders from. Sessions counts are deliberately
   * NOT included — the client only needs enough to offer a choice, and a per-record
   * count would mean reading the whole session store on a menu open.
   *
   * @returns `{ workspaces: [{ id, title, path }] }`, in display order.
   */
  async listMainWorkspaces() {
    // `resolveRuntime` is what fills `this.home`, and it is lazy: a page that has
    // not otherwise touched a sub-interface reaches this endpoint first. Reading
    // `this.home` before it is set throws `path must be of type string, received
    // undefined`, which surfaced as HTTP 500 on `/mv/api/workspaces`.
    await this.resolveRuntime()
    const { readFile } = await import('node:fs/promises')
    const { existsSync } = await import('node:fs')
    const file = joinPath(this.home, 'storages', 'workspace.json')
    if (!existsSync(file)) return { workspaces: [] }
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      const records = parsed?.tables?.workspaces ?? {}
      const order = Array.isArray(parsed?.global?.workspaceIds) ? parsed.global.workspaceIds : Object.keys(records)
      const workspaces = []
      for (const id of order) {
        const record = records[id]
        if (record === undefined || typeof record.path !== 'string' || record.path === '') continue
        workspaces.push({
          id,
          path: record.path,
          title: typeof record.title === 'string' && record.title !== '' ? record.title : record.path,
        })
      }
      return { workspaces }
    } catch (error) {
      this.log.warn('multiview: could not read the main workspace registry (%s)', String(error))
      return { workspaces: [] }
    }
  }

  /** Every live sub-interface, in creation order. */
  list() {
    return [...this.views.values()].map((view) => ({
      ...view.describe(),
      /** Browser windows currently open for this sub-interface. */
      windows: this.windowCount(view.id),
      /** How this view's plugins are meant to run: through the main interface, or at its own address. */
      pluginMode: this.pluginModes?.get(view.id) ?? 'main',
    }))
  }

  /**
   * The sub-interface profiles that exist but are NOT running: closed tabs
   * whose data is still on disk. This is the 已关闭的分界面 section the
   * settings page renders — the only place a closed sub-interface can be
   * reopened or reset.
   *
   * @returns `{ profiles: [{ id, profile, pluginMode? }] }`.
   */
  async listClosedProfiles() {
    await this.resolveRuntime()
    const { existsSync, readdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const profilesDir = joinPath(this.home, 'profiles')
    const out = []
    try {
      for (const name of readdirSync(profilesDir)) {
        if (!name.startsWith(this.config.profilePrefix)) continue
        const id = name.slice(this.config.profilePrefix.length)
        if (id === '' || this.views.has(id)) continue
        if (!existsSync(joinPath(profilesDir, name, 'package.json'))) continue
        out.push({
          id,
          profile: name,
          pluginMode: this.pluginModes?.get(id),
        })
      }
    } catch (error) {
      this.log.warn('multiview: could not list closed profiles (%s)', String(error))
    }
    return { profiles: out }
  }

  /** The model rows currently mirrored into sub-interfaces. */
  async modelConfiguration() {
    const { readFile } = await import('node:fs/promises')
    // Resolve the paths first: this endpoint is read by the settings page and
    // may well be the first call the plugin ever serves.
    await this.resolveRuntime()
    if (this.mainPatchPath === undefined) return { rows: [], source: undefined }
    try {
      const text = await readFile(this.mainPatchPath, 'utf8')
      const wanted = new Set(this.config.sharedRowIds)
      const ids = splitPatchEntries(text).map(entryId).filter((id) => id !== undefined && wanted.has(id))
      return { rows: ids, source: this.mainPatchPath }
    } catch {
      return { rows: [], source: this.mainPatchPath }
    }
  }

  /** Re-mirror the model configuration into every sub-interface. */
  async syncAll() {
    const synced = []
    for (const id of this.views.keys()) {
      try {
        synced.push({ id, ...(await this.syncModelConfiguration(id)) })
      } catch (error) {
        synced.push({ id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return synced
  }

  /** Proxy target for one running sub-interface. */
  target(id) {
    const view = this.views.get(id)
    if (view === undefined || view.origin === undefined || view.cookie === undefined) return undefined
    return { origin: view.origin, cookie: view.cookie }
  }

  /**
   * Call one unary RPC on a running child host, and return its value.
   *
   * The envelope is the generated client's: a `client-request` frame whose
   * `payload` wraps the endpoint's single named parameter in one `args` field.
   * A refusal arrives as **HTTP 200** with `result.ok: false`, so the envelope —
   * not the status — is what decides, and a caller must not read a status code
   * as success.
   *
   * @param id - the sub-interface to call.
   * @param method - the endpoint, e.g. `workspace/create`.
   * @param request - the endpoint's own argument object.
   * @returns `{ ok, value, error }`; `ok` is false for any refusal or failure.
   */
  async #callChildRpc(id, method, request) {
    const target = this.target(id)
    if (target === undefined) return { ok: false, error: 'the sub-interface is not running' }
    try {
      const response = await fetch(`${target.origin}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: target.cookie },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: randomUUID(),
          method,
          payload: { args: { request } },
        }),
      })
      const text = await response.text()
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        return { ok: false, error: `HTTP ${String(response.status)}: ${text.slice(0, 200)}` }
      }
      if (parsed?.result?.ok !== true) {
        const message = String(parsed?.result?.error?.message ?? `HTTP ${String(response.status)}`)
        this.log.warn('multiview: the child refused %s for %s (%s)', method, id, message)
        return { ok: false, error: message }
      }
      return { ok: true, value: parsed.result.value }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * The main host's own authenticated URL. Used by the shell's external-open
   * path to show the main interface in a real separate window, and by the
   * ticket minted for the file viewer. Resolved once and reused.
   */
  async mainAuth() {
    if (this.mainAuthValue !== undefined) return this.mainAuthValue
    await this.resolveRuntime()
    if (this.mainOrigin === undefined) return undefined
    const connection = this.ctx.get('connection')
    if (connection === undefined) return undefined
    const url = connection.authenticatedUrl(`${this.mainOrigin}/`)
    const token = new URL(url).searchParams.get('token') ?? undefined
    this.mainAuthValue = { origin: this.mainOrigin, token, url }
    return this.mainAuthValue
  }

  /**
   * Mint a short-lived capability URL for the file viewer.
   *
   * The shell opens http(s) URLs in the operating system's browser, which has
   * none of this app's cookies, so a cookie-authenticated route could not be
   * opened in a real separate window. A one-shot ticket carried in the URL is
   * the standard answer: it is random, single-use, expires quickly, and is only
   * ever handed to the shell's own external-open call.
   * @param path - absolute file path to display.
   * @returns the origin-relative viewer URL.
   */
  mintFileTicket(path) {
    const ticket = randomUUID().replace(/-/g, '')
    this.fileTickets.set(ticket, { path, expiresAt: Date.now() + 5 * 60 * 1000 })
    // Bound memory: drop expired tickets on every mint.
    for (const [key, value] of this.fileTickets) {
      if (value.expiresAt <= Date.now()) this.fileTickets.delete(key)
    }
    return `${ROUTE_PREFIX}/file?path=${encodeURIComponent(path)}&ticket=${ticket}`
  }

  /** Consume a file ticket, returning its path once. */
  takeFileTicket(ticket) {
    const entry = this.fileTickets.get(ticket)
    if (entry === undefined) return undefined
    this.fileTickets.delete(ticket)
    if (entry.expiresAt <= Date.now()) return undefined
    return entry.path
  }

  /** The child's own authenticated URL, for opening a real separate window. */
  externalUrl(id) {
    return this.views.get(id)?.externalUrl()
  }

  /**
   * One workspace from a sub-interface's registry, or undefined.
   *
   * The sidebar renders each workspace row as
   * `data-row-key="workspace:<uuid>"`, and the registry is the only place that
   * id maps to a directory — the row shows a *title*, and titles are not unique
   * (this machine has two workspaces called "skill").
   *
   * **Which registry** is now a real question: with isolation on, a
   * sub-interface has its own, seeded from the main one at creation. The child's
   * registry is therefore consulted first, because that is the one whose ids the
   * sub-interface's own sidebar actually renders — a workspace created inside the
   * sub-interface exists only there, and looking it up in the main registry would
   * report "unknown workspace" for a row the user is looking at. The main
   * registry remains the fallback, so a workspace window still works for a
   * sub-interface that shares the stores (isolation off, or an id opened before
   * it was seeded).
   *
   * @param workspaceId - the uuid from the row's `data-row-key`.
   * @param viewId - the sub-interface whose registry to read first, when known.
   * @returns `{ id, path, title }`, or undefined when it is not a known workspace.
   */
  async workspaceById(workspaceId, viewId) {
    const { readFile } = await import('node:fs/promises')
    const candidates = []
    if (typeof viewId === 'string' && viewId !== '' && this.config.isolateWorkspaces) {
      candidates.push(joinPath(this.dataDir(viewId), 'storages', 'workspace.json'))
    }
    candidates.push(joinPath(this.home, 'storages', 'workspace.json'))
    for (const file of candidates) {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'))
        const entry = parsed?.tables?.workspaces?.[workspaceId]
        if (entry === undefined || typeof entry.path !== 'string' || entry.path === '') continue
        return {
          id: workspaceId,
          path: entry.path,
          title: typeof entry.title === 'string' && entry.title !== '' ? entry.title : entry.path,
          registry: file,
        }
      } catch {
        /* try the next registry */
      }
    }
    return undefined
  }

  /**
   * Ensure a session for one workspace directory inside one child host, and
   * return its id.
   *
   * `session/create` accepts a `cwd`, so the child can be pointed at a workspace
   * before its client ever boots. The id it returns is what the window is then
   * primed with (see {@link WINDOW_SESSION_QUERY}).
   *
   * The workspace is registered **first**, and that order is load-bearing rather
   * than tidy. A session created by `cwd` alone belongs to no workspace record:
   * the registry is only consulted when the request names a `workspaceId`, and a
   * `cwd`-only session therefore ends up in the child's session store with no
   * count against any workspace, so the sidebar has no row to group it under.
   * `workspace/create` is idempotent (it returns the existing record for an
   * already-canonical path, `created: false`), so calling it here is free for a
   * workspace the seed already covers.
   *
   * `session/create` then takes **`workspaceId` alone**. Passing `cwd` as well is
   * refused outright —
   * `gateway/bad-request: session.create accepts workspaceId or cwd, not both` —
   * which is measured, not assumed.
   *
   * The payload shape is the generated typert client's, and it is not guessable:
   * the endpoint's single parameter is named `request`, and it is wrapped in one
   * `args` field — so the body is
   * `{ …, payload: { args: { request: { … } } } }`. A live child answers
   * `gateway/arguments-invalid: missing "request"` for any other shape.
   *
   * A refusal arrives as **HTTP 200** with `result.ok: false`, so the status
   * alone proves nothing; the envelope decides.
   *
   * Public (rather than private) because it is the one piece of the workspace
   * window that talks a wire protocol this plugin does not own: the regression
   * suite drives it directly against a scratch directory so the shape is verified
   * rather than assumed.
   *
   * @returns the session id, or undefined when the child refused.
   */
  async ensureWorkspaceSession(id, cwd) {
    if (this.target(id) === undefined) return undefined
    // Register the directory so the session has a workspace to belong to.
    const registered = await this.#callChildRpc(id, 'workspace/create', { path: cwd })
    const workspaceId = registered.ok ? registered.value?.workspace?.workspaceId : undefined
    if (typeof workspaceId !== 'string' || workspaceId === '') {
      this.log.warn(
        'multiview: could not register %s as a workspace in %s (%s); its session would have no workspace to group under',
        cwd, id, String(registered.error ?? 'the child returned no workspace id'),
      )
      return undefined
    }
    // `workspaceId` ALONE: the endpoint refuses `workspaceId` and `cwd` together.
    const created = await this.#callChildRpc(id, 'session/create', { workspaceId })
    if (!created.ok) return undefined
    const sessionId = created.value?.sessionId
    return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
  }

  /**
   * Record the workspace directory a sub-interface is working in.
   *
   * Called by the client half whenever the operator activates a workspace in
   * that sub-interface (and by open, with the seed). This is what makes
   * 重新打开 land back where the operator was instead of wherever the
   * sidebar happens to sort first.
   *
   * @param id - the sub-interface id.
   * @param cwd - the workspace directory (absolute, canonical spelling).
   * @param workspaceId - the id in that sub-interface's own registry, when known.
   */
  rememberCurrentWorkspace(id, cwd, workspaceId) {
    if (typeof cwd !== 'string' || cwd === '') return
    this.currentWorkspaces.set(id, {
      cwd,
      ...(typeof workspaceId === 'string' && workspaceId !== '' ? { workspaceId } : {}),
    })
  }

  /** The recorded current workspace of one sub-interface, or undefined. */
  currentWorkspaceOf(id) {
    return this.currentWorkspaces.get(id)
  }

  /**
   * Mint an id for a NEW sub-interface: `view-N`, skipping every N already in
   * use by a live view or an existing profile directory.
   *
   * Creation used to derive the id from the visible tab count, so after
   * closing `view-2` (its profile still on disk) the next 新建 minted
   * `view-2` again and `ensureProfile` silently adopted the closed
   * sub-interface's leftover data — new tabs coming back full of old state.
   * Asking the Host, which can see the profile directories, is what makes
   * every 新建 a genuinely fresh one.
   *
   * @returns a promise resolving to an unused `view-N` id.
   */
  async mintViewId() {
    await this.resolveRuntime()
    const { existsSync } = await import('node:fs')
    for (let index = 1; index < 10000; index += 1) {
      const id = `view-${String(index)}`
      if (this.views.has(id)) continue
      if (existsSync(joinPath(this.home, 'profiles', `${this.config.profilePrefix}${id}`, 'package.json'))) continue
      return id
    }
    throw new Error('multiview: no free view id (view-1 … view-9999 are all taken)')
  }

  /**
   * After a (re)start, put the child back on its recorded current workspace.
   *
   * A freshly booted client restores whichever session its local state names —
   * and for a new child that is "none", so the sidebar's first workspace wins.
   * Creating a session for the recorded directory (workspace/create is
   * idempotent, session/create is one call) and priming it is what makes
   * 重新打开 mean "same place as before". Best-effort: a child that refuses
   * just keeps its own default.
   *
   * @param id - the sub-interface id (must be running).
   */
  async restoreCurrentWorkspace(id) {
    const record = this.currentWorkspaces.get(id)
    if (record === undefined || this.target(id) === undefined) return undefined
    try {
      const sessionId = await this.ensureWorkspaceSession(id, record.cwd)
      if (sessionId === undefined) return undefined
      this.log.info('multiview: sub-interface %s restored to workspace %s', id, record.cwd)
      return sessionId
    } catch (error) {
      this.log.warn('multiview: could not restore the current workspace of %s (%s)', id, String(error))
      return undefined
    }
  }

  /**
   * Open one workspace in its own operating-system window.
   *
   * Long-pressing a sidebar workspace row lands here. The row carries a
   * workspace **id**, so the directory comes from the shared registry and never
   * from the row's title; the window then gets a sub-interface of its own (id
   * derived from that workspace, so the same workspace always reuses one) with a
   * session already created for that directory.
   *
   * @param workspaceId - the uuid from the row's `data-row-key`.
   * @returns what was opened.
   */
  async openWorkspaceWindow(workspaceId) {
    await this.resolveRuntime()
    // The id is derived from the workspace id and is therefore known before the
    // lookup, which matters with isolation on: the sub-interface may already hold
    // its own record for this workspace, and that record is the authoritative one
    // once it exists.
    const id = `ws-${workspaceId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`
    const workspace = await this.workspaceById(workspaceId, id)
    if (workspace === undefined) {
      throw new Error(`multiview: workspace ${JSON.stringify(workspaceId)} is not in the workspace registry, so its directory is unknown`)
    }
    if (this.views.get(id) === undefined) await this.open({ id, label: workspace.title })
    await this.start(id)
    const sessionId = await this.ensureWorkspaceSession(id, workspace.path)
    const opened = await this.openWindow(id, sessionId)
    this.log.info(
      'multiview: opened workspace %s (%s) as sub-interface %s%s',
      workspace.title, workspace.path, id, sessionId === undefined ? ' (no session primed)' : ` at ${sessionId}`,
    )
    return { ...opened, id, workspace, sessionId }
  }

  // -------------------------------------------------------------------------
  // Mount authentication
  // -------------------------------------------------------------------------

  /**
   * Decide whether a `/mv/**` request may proceed.
   *
   * Two credentials are accepted:
   *
   *  1. **This app's own session.** The desktop shell attaches the host session
   *     cookie to everything the in-app frame asks for, and to the
   *     `ws://127.0.0.1/*` Remote stream handshake, so the in-app sub-interface
   *     passes without knowing anything about any of this.
   *  2. **A browser-window session**, minted from a one-shot ticket. It is bound
   *     to one sub-interface id, so a window opened for one view can never read
   *     another.
   *
   * The loopback/Origin fence runs first in both cases: that is the
   * DNS-rebinding defence, not authentication.
   *
   * @param req - node HTTP request (also used for the upgrade handshake).
   * @param id - the sub-interface being requested, when known.
   * @returns true when the request carries one of those credentials.
   */
  admitsMount(req, id) {
    if (this.config.mountAuth === 'off') return true
    if (!isTrustedRequest(req)) return false
    if (id !== undefined && this.windowSessionView(req) === id) return true
    return this.#admission(req) ?? true
  }

  /** The control API answers this app's own client only, never a browser window. */
  admitsControl(req) {
    return this.admitsMount(req, undefined)
  }

  /**
   * The host's own admission verdict, or undefined when this composition has no
   * `connection` service to ask. A missing service is a degradation, not a
   * refusal: the plugin then falls back to the loopback fence alone, which is
   * exactly the pre-0.2 behaviour.
   */
  #admission(req) {
    const connection = this.ctx.get('connection')
    if (connection === undefined || typeof connection.admit !== 'function') {
      if (!this.warnedNoConnection) {
        this.warnedNoConnection = true
        this.log.warn('multiview: this composition provides no `connection` service, so `/mv/**` cannot verify the app session (set config mountAuth: off to acknowledge)')
      }
      return undefined
    }
    try {
      return connection.admit(req)?.rejection === undefined
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // Browser windows
  // -------------------------------------------------------------------------

  /**
   * The authenticated URL a browser window should open.
   *
   * For a sub-interface this is now the child's **own address** — its stable
   * port plus its own launch token — not the main-origin mount. Opening the
   * child directly is what makes plugins whose client half talks to their own
   * host half (relative-path fetches like `/wyymusic/...`) work in that
   * window: the page's origin IS the child, so the fetches land on the child.
   * A window on the mount would keep routing those fetches to the main host,
   * where the child's plugins have no routes.
   *
   * The stable port is what makes this survivable: the token is one-shot, so
   * a window that outlives the process shows its own "link expired" refresh
   * affordance and a reload lands on the fresh process at the same address.
   *
   * `main` keeps its existing behaviour (the main interface's authenticated
   * URL). The mount URL is no longer produced here; the in-app iframe path
   * uses the mount directly and does not go through this method.
   *
   * @param id - a sub-interface id, or `main` for the main interface.
   * @returns the URL, or undefined when the target cannot be opened yet.
   */
  async windowUrl(id, sessionId) {
    if (id === 'main') {
      const auth = await this.mainAuth()
      return auth?.url
    }
    if (this.mainOrigin === undefined) await this.resolveRuntime()
    const view = this.views.get(id)
    if (view === undefined || view.state !== 'running') return undefined
    void sessionId
    return view.externalUrl()
  }

  /** Mint a one-shot ticket for a browser window on one sub-interface. */
  mintWindowTicket(id) {
    const ticket = randomUUID().replace(/-/g, '')
    const now = Date.now()
    this.windowTickets.set(ticket, { id, expiresAt: now + 5 * 60 * 1000 })
    for (const [key, value] of this.windowTickets) {
      if (value.expiresAt <= now) this.windowTickets.delete(key)
    }
    return ticket
  }

  /** Consume a window ticket, once, for the sub-interface it was minted for. */
  takeWindowTicket(ticket, id) {
    const entry = this.windowTickets.get(ticket)
    if (entry === undefined) return false
    this.windowTickets.delete(ticket)
    return entry.id === id && entry.expiresAt > Date.now()
  }

  /** Mint the scoped session cookie a browser window carries afterwards. */
  issueWindowSession(id) {
    const token = randomUUID().replace(/-/g, '')
    const now = Date.now()
    this.windowSessions.set(token, { id, expiresAt: now + this.config.windowSessionMs })
    for (const [key, value] of this.windowSessions) {
      if (value.expiresAt <= now) this.windowSessions.delete(key)
    }
    return { token, maxAgeSeconds: Math.floor(this.config.windowSessionMs / 1000) }
  }

  /** The sub-interface a browser window's cookie names, or undefined. */
  windowSessionView(req) {
    const token = cookieValue(req.headers.cookie, WINDOW_COOKIE)
    if (token === undefined) return undefined
    const entry = this.windowSessions.get(token)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.windowSessions.delete(token)
      return undefined
    }
    return entry.id
  }

  /** How many browser windows are open for one id. */
  windowCount(id) {
    return this.externalWindows.get(id)?.size ?? 0
  }

  /**
   * Close every browser window opened for one id, and drop its sessions.
   *
   * A browser window is only a client of the child host, so it cannot outlive
   * that host: stopping or closing a sub-interface closes its windows instead of
   * leaving them pointed at a backend that is gone.
   *
   * The close is graceful first, forced only after a grace period. A hard
   * `kill()` on Windows destroys the browser window without letting the OS
   * return keyboard focus to the previous window — the desktop shell is left
   * unable to accept typing until it loses and regains focus (the tray
   * icon click users discovered as the workaround). A graceful close lets the
   * browser exit normally and focus falls back on its own.
   *
   * @returns how many browser processes were asked to close.
   */
  closeWindows(id) {
    const windows = this.externalWindows.get(id)
    let closed = 0
    if (windows !== undefined) {
      closed = windows.size
      const survivors = new Set()
      for (const child of windows) {
        try {
          if (child.exitCode === null && child.signalCode === null) {
            // Graceful first: taskkill without /F sends WM_CLOSE, so the
            // browser tears down its windows and focus returns naturally.
            if (process.platform === 'win32') {
              const { spawn } = require('node:child_process')
              spawn('taskkill', ['/pid', String(child.pid)], { stdio: 'ignore', windowsHide: true })
            } else {
              child.kill()
            }
            survivors.add(child)
          }
          // Already-exited processes are simply forgotten.
        } catch {
          /* already gone */
        }
      }
      if (survivors.size > 0) {
        // If a graceful close does not finish in time, force it — but by then
        // the user has usually already interacted with something else, so the
        // focus damage is far less likely to land on the desktop shell.
        setTimeout(() => {
          for (const child of survivors) {
            try { child.kill() } catch { /* already gone */ }
          }
        }, 3000)
        this.externalWindows.set(id, survivors)
      } else {
        this.externalWindows.delete(id)
      }
    }
    for (const [token, entry] of this.windowSessions) {
      if (entry.id === id) this.windowSessions.delete(token)
    }
    return closed
  }

  /**
   * Open a browser window for a sub-interface (or the main interface).
   *
   * The window is a Chromium *app window* (`--app`): no tab strip, no address
   * bar, an ordinary draggable OS window with its own taskbar entry. It is given
   * a dedicated profile directory, which is what makes the process ours — the
   * browser that owns the window stays alive, so its exit is observable and the
   * window can be closed on demand, and it never shares cookies or history with
   * the person's everyday browsing.
   *
   * Window SIZE is remembered per view (`$DSH_HOME/multiview/windows/<id>/
   * window.json`): without it Chromium app windows open at the engine's own
   * default — about half the screen. The saved size is passed with
   * `--window-size`, and after launch a lightweight platform probe reads the
   * real window rect once and re-saves it, so a manually resized window keeps
   * its size across reopen.
   *
   * @param id - a sub-interface id, or `main`.
   * @returns a description of what was launched.
   */
  async openWindow(id, sessionId) {
    const url = await this.windowUrl(id, sessionId)
    if (url === undefined) throw new Error(`multiview: ${JSON.stringify(id)} is not running, so it has no window to open`)
    const { spawn } = await import('node:child_process')
    const { join } = await import('node:path')
    const { mkdir } = await import('node:fs/promises')

    const browser = await this.#findChromium()
    let child
    if (browser === undefined) {
      child = await this.#openInDefaultBrowser(url)
    } else {
      const profileDir = join(this.home, 'multiview', 'windows', id)
      await mkdir(profileDir, { recursive: true })
      const args = [
        `--app=${url}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
      ]
      const savedSize = await this.#readWindowSize(id)
      if (savedSize !== undefined) args.push(`--window-size=${savedSize.width},${savedSize.height}`)
      child = spawn(browser, args, { stdio: 'ignore', windowsHide: true })
      // The window takes a moment to appear and settle; then read back the
      // REAL rect (covering manual resizes and the browser's own clamping to
      // the work area) and remember it for next time.
      setTimeout(() => { void this.#captureWindowSize(id) }, 2500)
    }
    this.#trackWindow(id, child)
    this.log.info('multiview: opened a browser window for %s with %s', id, browser ?? 'the system default browser')
    return { id, browser: browser ?? 'system-default', pid: child.pid, appMode: browser !== undefined }
  }

  /** Close a browser window by its process id, when it is one of ours. */
  closeWindow(id, pid) {
    const windows = this.externalWindows.get(id)
    if (windows === undefined) return false
    for (const child of windows) {
      if (child.pid === pid) {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        return true
      }
    }
    return false
  }

  /** Remember a browser process so it can be reported and closed. */
  #trackWindow(id, child) {
    const windows = this.externalWindows.get(id) ?? new Set()
    windows.add(child)
    this.externalWindows.set(id, windows)
    const forget = () => {
      const current = this.externalWindows.get(id)
      if (current === undefined) return
      current.delete(child)
      if (current.size === 0) this.externalWindows.delete(id)
      this.log.info('multiview: a browser window for %s closed (%s still open)', id, String(current.size))
    }
    child.once('exit', forget)
    child.once('error', forget)
  }

  /** The saved window-size file for one view. */
  #windowSizeFile(id) {
    return joinPath(this.home, 'multiview', 'windows', id, 'window.json')
  }

  /** The saved window size for one view, or undefined when none is recorded. */
  async #readWindowSize(id) {
    try {
      const { readFile } = await import('node:fs/promises')
      const parsed = JSON.parse(await readFile(this.#windowSizeFile(id), 'utf8'))
      const width = Number(parsed?.width)
      const height = Number(parsed?.height)
      // A sane window is at least 300×200; anything else is corruption.
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 300 || height < 200) return undefined
      return { width: Math.round(width), height: Math.round(height) }
    } catch {
      return undefined
    }
  }

  /** Persist the window size for one view (whole-file rewrite). */
  async #saveWindowSize(id, width, height) {
    try {
      const { mkdir, writeFile } = await import('node:fs/promises')
      const { dirname } = await import('node:path')
      const file = this.#windowSizeFile(id)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `${JSON.stringify({ width, height }, null, 2)}\n`, 'utf8')
    } catch (error) {
      this.log.warn('multiview: could not save the window size of %s (%s)', id, String(error))
    }
  }

  /**
   * Read the live window rect through a short-lived helper process and save it.
   *
   * The probe runs OUTSIDE this process because reading another process's
   * window rect needs platform APIs Electron-as-Node does not ship: on Windows
   * a few lines of PowerShell with .NET's Win32 interop (`GetWindowRect` on the
   * probe's own host process is not enough — the Chromium window belongs to a
   * sibling process tree, so the probe enumerates by process id and picks the
   * largest visible top-level window). Everything is best-effort: any failure
   * simply leaves the previously saved size in place.
   */
  async #captureWindowSize(id) {
    try {
      if (process.platform !== 'win32') return // other platforms: skip for now
      const windows = this.externalWindows.get(id)
      if (windows === undefined || windows.size === 0) return
      const pids = [...windows].map((child) => String(child.pid)).filter(Boolean)
      if (pids.length === 0) return
      // Chromium spawns a tree (browser main + renderer/GPU children); the
      // top-level WINDOW belongs to one of them. Enumerate each pid's visible
      // windows and take the largest rect.
      //
      // The C# source travels BASE64-ENCODED and is decoded inside PowerShell.
      // The previous build inlined it in a here-string and passed the whole
      // script through `-Command`: PowerShell's argument parser re-wraps the
      // script text, the here-string terminator `@` no longer sat at column 0,
      // and every probe died with "string is not terminated" before producing
      // a single byte of output — which is why window sizes were never saved.
      // Base64 is immune to quoting entirely; `#`-prefixed stderr progress
      // records are filtered from stdout before parsing.
      const csharp = [
        'using System; using System.Text; using System.Runtime.InteropServices;',
        'public class MvWin {',
        '[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);',
        'public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
        '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
        '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
        '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);',
        'public struct RECT { public int Left, Top, Right, Bottom; }',
        'public static string LargestFor(uint wantPid) {',
        '  long best = 0; string bestRect = null;',
        '  EnumWindows((h, lp) => {',
        '    uint pid; GetWindowThreadProcessId(h, out pid);',
        '    if (pid != wantPid || !IsWindowVisible(h)) return true;',
        '    RECT r; if (!GetWindowRect(h, out r)) return true;',
        '    long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);',
        '    if (area > best && r.Right - r.Left > 100 && r.Bottom - r.Top > 100) { best = area; bestRect = r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top); }',
        '    return true;',
        '  }, IntPtr.Zero);',
        '  return bestRect ?? "";',
        '}',
        '}',
      ].join('\r\n')
      const csharpB64 = Buffer.from(csharp, 'utf16le').toString('base64')
      const script = [
        'Add-Type -TypeDefinition ([System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("' + csharpB64 + '")))',
        ...pids.map((pid) => `$r = [MvWin]::LargestFor(${pid})`),
        'if ($r) { Write-Output $r }',
      ].join('\r\n')
      const { spawn } = await import('node:child_process')
      const probe = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let out = ''
      let err = ''
      probe.stdout.setEncoding('utf8')
      probe.stderr.setEncoding('utf8')
      probe.stdout.on('data', (chunk) => { out += chunk })
      probe.stderr.on('data', (chunk) => { err += chunk })
      const done = new Promise((resolve) => {
        const timer = setTimeout(() => { try { probe.kill() } catch { /* gone */ } resolve() }, 8000)
        probe.once('exit', () => { clearTimeout(timer); resolve() })
        probe.once('error', () => { clearTimeout(timer); resolve() })
      })
      await done
      // PowerShell progress records land on stderr as CLIXML ("#< CLIXML...");
      // only stdout lines shaped like a rect are candidates.
      const line = out.split(/\r?\n/).map((v) => v.trim()).find((v) => /^\d+,\d+,\d+,\d+$/.test(v))
      if (line === undefined) {
        this.log.warn('multiview: window-size probe returned no rect for %s%s', id, err.trim() === '' ? '' : ` (${err.trim().slice(0, 120)})`)
        return
      }
      const parts = line.split(',').map((v) => Number(v))
      const [, , width, height] = parts
      if (width < 300 || height < 200) return
      await this.#saveWindowSize(id, width, height)
      this.log.info('multiview: captured window size of %s as %dx%d', id, width, height)
    } catch (error) {
      this.log.warn('multiview: could not capture the window size of %s (%s)', id, String(error))
    }
  }

  /** Open a URL in whatever the platform's default browser is (a plain tab). */
  async #openInDefaultBrowser(url) {
    const { spawn } = await import('node:child_process')
    if (process.platform === 'win32') {
      // `start` is a cmd builtin, so it needs a shell; the empty title argument
      // keeps a quoted URL from being read as the window title.
      return spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true })
    }
    if (process.platform === 'darwin') return spawn('open', [url], { stdio: 'ignore' })
    return spawn('xdg-open', [url], { stdio: 'ignore' })
  }

  /**
   * Find a Chromium browser to host an `--app` window.
   *
   * `--app` is a Chromium switch: Firefox and Safari have no equivalent, so a
   * non-Chromium default browser cannot produce this kind of window and the
   * caller falls back to a plain tab. On Windows the configured default browser
   * is honoured when it is Chromium-based, which is what makes "默认浏览器" true
   * rather than aspirational; otherwise Edge (shipped with Windows) or Chrome is
   * used. Override with `config.browserCommand`.
   *
   * @returns an executable path, or undefined when none was found.
   */
  async #findChromium() {
    const configured = this.config.browserCommand !== '' ? this.config.browserCommand : process.env.DSH_MULTIVIEW_BROWSER
    if (typeof configured === 'string' && configured !== '') return configured

    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const looksChromium = (path) => /(msedge|chrome|chromium|brave|vivaldi|opera)\.exe$/i.test(path)

    if (process.platform === 'win32') {
      const defaultBrowser = await this.#windowsDefaultBrowser()
      if (defaultBrowser !== undefined && existsSync(defaultBrowser) && looksChromium(defaultBrowser)) return defaultBrowser
      const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
      const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
      const localAppData = process.env.LOCALAPPDATA ?? ''
      const candidates = [
        join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]
      return candidates.find((candidate) => candidate !== '' && existsSync(candidate))
    }

    if (process.platform === 'darwin') {
      const candidates = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ]
      return candidates.find((candidate) => existsSync(candidate))
    }

    const { execFile } = await import('node:child_process')
    const names = ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']
    for (const name of names) {
      const found = await new Promise((resolve) => {
        execFile('which', [name], (error, stdout) => {
          resolve(error === null && typeof stdout === 'string' && stdout.trim() !== '' ? stdout.trim() : undefined)
        })
      })
      if (found !== undefined) return found
    }
    return undefined
  }

  /**
   * The executable behind the Windows default-browser choice, or undefined.
   *
   * Read through `reg.exe` and tolerated to fail: a registry shape that is not
   * the expected one must degrade to the known install locations, never throw.
   */
  async #windowsDefaultBrowser() {
    const { execFile } = await import('node:child_process')
    const query = (key) => new Promise((resolve) => {
      execFile('reg.exe', ['query', key, '/ve'], { windowsHide: true }, (error, stdout) => {
        resolve(error === null && typeof stdout === 'string' ? stdout : undefined)
      })
    })
    const choice = await query('HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice')
    if (choice === undefined) return undefined
    const progId = /\sREG_SZ\s+(\S+)\s*$/.exec(choice)?.[1]
    if (progId === undefined) return undefined
    const command = await query(`HKCR\\${progId}\\shell\\open\\command`)
    if (command === undefined) return undefined
    // `"C:\...\msedge.exe" --single-argument %1`
    const executable = /"([^"]+\.exe)"/i.exec(command)?.[1] ?? /(\S+\.exe)/i.exec(command)?.[1]
    return executable
  }

  /** Tear down every child process and route. */
  async disposeAll() {
    for (const id of [...this.externalWindows.keys()]) this.closeWindows(id)
    const ids = [...this.views.keys()]
    for (const id of ids) this.#releaseUpgradeRoute(id)
    const views = [...this.views.values()]
    this.views.clear()
    await Promise.allSettled(views.map((view) => view.stop()))
  }
}

// ---------------------------------------------------------------------------
// Served pages
// ---------------------------------------------------------------------------

/** Minimal HTML shell for plugin-served pages (theme-matched, no dependencies). */
function pageDocument(title, body, script = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title.replace(/[<>&]/g, '')}</title>
<style>
:root { color-scheme: light dark; --bg:#ffffff; --fg:#0f1115; --muted:#5b6270; --line:#e3e5e9; --code:#f6f7f9; }
@media (prefers-color-scheme: dark) { :root { --bg:#1b1b22; --fg:#f9fafb; --muted:#9aa1ad; --line:#2c2d36; --code:#22232b; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:13px/1.6 ui-sans-serif,system-ui,"Segoe UI",sans-serif; }
header { position:sticky; top:0; display:flex; gap:10px; align-items:center; padding:10px 14px; border-bottom:1px solid var(--line); background:var(--bg); }
h1 { margin:0; font-size:13px; font-weight:600; }
.path { color:var(--muted); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
main { padding:0; }
pre { margin:0; padding:14px; background:var(--code); font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre; overflow:auto; }
.empty { padding:24px 14px; color:var(--muted); }
</style>
</head>
<body>
${body}
${script}
</body>
</html>
`
}

/** Escape text for HTML insertion. */
function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Plugin body
// ---------------------------------------------------------------------------

/**
 * Mount the supervisor, its API, its proxy, and the upgrade routes.
 * @param ctx - Host plugin context carrying `webServer`.
 * @param rawConfig - the row's `config` from `cordis.patch.yml`.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const service = new MultiViewService(ctx, config)
  ctx.provide('multiview', service)

  // Child processes must not outlive the fiber that started them.
  ctx.effect(() => () => { void service.disposeAll() }, 'multiview: child hosts')

  // --- API -----------------------------------------------------------------
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: `${ROUTE_PREFIX}/api`,
    handler: async (req, res) => {
      // The control API starts hosts and mints window tickets, so the loopback
      // fence alone is not enough here: it needs this app's own session. A
      // browser window's scoped cookie is deliberately not accepted.
      if (!service.admitsControl(req)) {
        const fenced = isTrustedRequest(req)
        res.writeHead(fenced ? 401 : 403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(fenced ? 'unauthorized' : 'forbidden')
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname.slice(`${ROUTE_PREFIX}/api`.length)
      try {
        const body = req.method === 'POST' ? await readJsonBody(req) : {}
        switch (pathname) {
          case '/list':
            sendJson(res, 200, {
              views: service.list(),
              config: {
                autoStart: config.autoStart,
                maxViews: config.maxViews,
                profilePrefix: config.profilePrefix,
                profileTemplate: config.profileTemplate,
                // The client needs this one to know whether to arm the
                // long-press-a-workspace gesture at all.
                workspaceWindows: config.workspaceWindows,
                // So the client knows what a new sub-interface will start with,
                // and whether to offer a starting-workspace choice.
                initialPlugins: config.initialPlugins,
                isolateWorkspaces: config.isolateWorkspaces,
              },
            })
            return
          case '/open':
            sendJson(res, 200, await service.open(body))
            return
          case '/start':
            sendJson(res, 200, await service.start(String(body.id)))
            return
          case '/stop':
            sendJson(res, 200, await service.stop(String(body.id)))
            return
          case '/close':
            sendJson(res, 200, await service.close(String(body.id)))
            return
          case '/remove':
            // Reset: stop, close its windows, and delete the profile — with the
            // profile's links unlinked first. Never delete a profile by hand.
            sendJson(res, 200, await service.removeView(String(body.id)))
            return
          case '/clear-data':
            // Clear only this sub-interface's own workspaces and sessions. Its
            // profile (and so its installed plugins) survives.
            sendJson(res, 200, await service.clearViewData(String(body.id)))
            return
          case '/restart': {
            // Stop, then start again. The child reads its configuration and its
            // stores once at boot, so this is what makes a cleared data set, a
            // newly enabled plugin, or a re-mirrored model config take effect
            // without the whole application being restarted.
            const id = String(body.id)
            await service.stop(id)
            sendJson(res, 200, await service.start(id))
            return
          }
          case '/duplicate':
            // Open a second sub-interface from the same starting point: the
            // source's plugin set and configuration, but its own profile and its
            // own isolated stores. The source is untouched.
            sendJson(res, 200, await service.duplicateView(String(body.id), typeof body.newId === 'string' ? body.newId : undefined))
            return
          case '/sync-plugins':
            // Copy the main interface's plugin set in (declared, still switched
            // off — enabling stays a per-sub-interface decision).
            sendJson(res, 200, await service.syncPlugins(String(body.id)))
            return
          case '/sync-workspaces':
            // Replace this sub-interface's workspace registry with the main
            // interface's. Sessions are a separate action.
            sendJson(res, 200, await service.syncWorkspaces(String(body.id)))
            return
          case '/sync-sessions':
            // Copy the main interface's sessions for ONE workspace into this
            // sub-interface's own session store.
            sendJson(res, 200, await service.syncSessions(
              String(body.id),
              typeof body.workspace === 'string' ? body.workspace : undefined,
              body.overwrite === true,
            ))
            return
          case '/workspaces':
            // The main interface's workspace list, for the "choose a starting
            // workspace" prompt when a sub-interface is created.
            sendJson(res, 200, await service.listMainWorkspaces())
            return
          case '/remember-workspace':
            // The client reports the workspace the operator is working in.
            // This is the memory behind 重新打开/复制打开/清空会话 landing
            // back where they were instead of wherever the sidebar sorts first.
            service.rememberCurrentWorkspace(String(body.id), typeof body.cwd === 'string' ? body.cwd : undefined, typeof body.workspaceId === 'string' ? body.workspaceId : undefined)
            sendJson(res, 200, { ok: true })
            return
          case '/mint-id': {
            // A fresh id for a NEW sub-interface: skips every live view AND
            // every profile directory still on disk (closed, un-reset ones),
            // so creation can never revive a closed sub-interface's leftover
            // data under a matching id.
            sendJson(res, 200, { id: await service.mintViewId() })
            return
          }
          case '/sync-models':
            sendJson(res, 200, { synced: await service.syncAll() })
            return
          case '/model-config':
            sendJson(res, 200, await service.modelConfiguration())
            return
          case '/closed-profiles':
            // Closed (stopped, tab dropped) but un-reset sub-interface
            // profiles: the settings page's 已关闭的分界面 section.
            sendJson(res, 200, await service.listClosedProfiles())
            return
          case '/favorites':
            // The SHARED favorite list (persisted in $DSH_HOME). GET without a
            // body reads it; POST with { id } toggles one entry. Every window
            // — main and independent alike — reads and writes this same list.
            if (typeof body.id === 'string' && body.id !== '') {
              sendJson(res, 200, await service.toggleFavorite(body.id))
            } else {
              sendJson(res, 200, await service.listFavorites())
            }
            return
          case '/external-url': {
            const url = service.externalUrl(String(body.id))
            if (url === undefined) {
              sendJson(res, 409, { error: `multiview: sub-interface ${JSON.stringify(String(body.id))} is not running` })
              return
            }
            sendJson(res, 200, { url })
            return
          }
          case '/window-url': {
            // The mount URL a browser window would open, ticket included. Minted
            // separately from `/window` so a caller can hand the URL to something
            // else (or show it) without this plugin launching anything.
            const url = await service.windowUrl(String(body.id))
            if (url === undefined) {
              sendJson(res, 409, { error: `multiview: ${JSON.stringify(String(body.id))} is not running, so it has no window to open` })
              return
            }
            sendJson(res, 200, { url })
            return
          }
          case '/window': {
            // A real operating-system window: a Chromium app window when one was
            // found, otherwise the platform's default browser as a plain tab.
            sendJson(res, 200, await service.openWindow(String(body.id)))
            return
          }
          case '/workspace-window': {
            // Long-press on a sidebar workspace row: its own sub-interface, a
            // session for that directory, and a window opened at it.
            sendJson(res, 200, await service.openWorkspaceWindow(String(body.workspaceId)))
            return
          }
          case '/window-close': {
            const id = String(body.id)
            const closed = Number.isSafeInteger(body.pid)
              ? (service.closeWindow(id, body.pid) ? 1 : 0)
              : service.closeWindows(id)
            sendJson(res, 200, { id, closed })
            return
          }
          case '/self-url': {
            // The main interface's own authenticated URL, so the shell's
            // external-open path can show it in a real separate window.
            const auth = await service.mainAuth()
            if (auth === undefined) {
              sendJson(res, 409, { error: 'multiview: the main interface URL is unavailable' })
              return
            }
            sendJson(res, 200, { url: auth.url })
            return
          }
          case '/file-url': {
            // A one-shot capability URL for the file viewer, minted so the
            // shell's external-open path can show the file in a real window.
            const path = typeof body.path === 'string' ? body.path : ''
            if (path === '') {
              sendJson(res, 400, { error: 'multiview: a file path is required' })
              return
            }
            const auth = await service.mainAuth()
            if (auth === undefined) {
              sendJson(res, 409, { error: 'multiview: the main interface URL is unavailable' })
              return
            }
            sendJson(res, 200, { url: `${auth.origin}${service.mintFileTicket(path)}` })
            return
          }
          case '/settings-url': {
            // Settings tear-off: the main interface itself, opened in a real
            // separate window on the settings panel.
            const auth = await service.mainAuth()
            if (auth === undefined) {
              sendJson(res, 409, { error: 'multiview: the main interface URL is unavailable' })
              return
            }
            sendJson(res, 200, { url: auth.url })
            return
          }
          default:
            res.writeHead(404)
            res.end('not found')
        }
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'multiview: api route')

  // --- File viewer ---------------------------------------------------------
  // A long-pressed workspace file path opens here in a real separate window.
  // The shell hands http(s) URLs to the operating system's browser, which has
  // none of this app's cookies, so the route authenticates with a one-shot
  // ticket minted by the API instead of with the session cookie. The file is
  // read through the Host's own filesystem service, so the window shows exactly
  // what the workspace contains.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/file`,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const send = (status, body) => {
        const buffer = Buffer.from(body, 'utf8')
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(buffer.length), 'cache-control': 'no-store' })
        res.end(buffer)
      }
      const path = service.takeFileTicket(url.searchParams.get('ticket') ?? '')
      if (path === undefined) {
        send(403, pageDocument('MultiView', '<header><h1>MultiView</h1></header><main><p class="empty">This file link has expired or was already used. Long-press the path again to reopen it.</p></main>'))
        return
      }
      const head = `<header><h1>${escapeHtml(path.split(/[\\/]/).pop() ?? path)}</h1><span class="path">${escapeHtml(path)}</span></header>`
      try {
        const fs = ctx.get('fs')
        if (fs === undefined) throw new Error('the filesystem service is unavailable')
        const target = await fs.resolve(path)
        const info = await fs.stat(target)
        if (info === undefined || info.type === 'directory') throw new Error('the path is not a readable file')
        if (typeof info.size === 'number' && info.size > 4 * 1024 * 1024) {
          send(200, pageDocument(path, `${head}<main><p class="empty">This file is larger than 4 MB. Open it in the workspace instead.</p></main>`))
          return
        }
        const text = await fs.readText(target)
        send(200, pageDocument(path, `${head}<main><pre>${escapeHtml(text)}</pre></main>`))
      } catch (error) {
        send(200, pageDocument(path, `${head}<main><p class="empty">${escapeHtml(error instanceof Error ? error.message : String(error))}</p></main>`))
      }
    },
  }), 'multiview: file route')

  // --- Proxy ---------------------------------------------------------------
  // Everything under /mv/<id>/ is forwarded to that child host, so the page
  // talks to a sub-interface on its own origin. The child's index is served
  // with its transport global pointing at this mount, which is what lets its
  // Remote stream WebSocket resolve to a URL the shell accepts.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      if (!isTrustedRequest(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const match = VIEW_PATH.exec(url.pathname)
      if (match === null) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const id = match[1]
      const rest = match[2]

      // A browser window holds none of this app's cookies, so its one-shot
      // ticket is exchanged here for a scoped session cookie and dropped from
      // the URL. It runs before the gate (it *is* the gate's other credential)
      // and before the bare-mount redirect, because the ticket may arrive on the
      // slash-less form.
      const ticket = url.searchParams.get(WINDOW_TICKET_QUERY)
      if (ticket !== null) {
        if (!service.takeWindowTicket(ticket, id)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end('multiview: this window link has expired or was already used. Open the window again from the tab bar.\n')
          return
        }
        const { token, maxAgeSeconds } = service.issueWindowSession(id)
        // The session hint has to survive the exchange: it is what points the
        // window at one workspace's session (see WINDOW_SESSION_QUERY).
        const session = url.searchParams.get(WINDOW_SESSION_QUERY)
        const carry = session === null ? '' : `?${WINDOW_SESSION_QUERY}=${encodeURIComponent(session)}`
        res.writeHead(303, {
          location: `${ROUTE_PREFIX}/${id}/${carry}`,
          'set-cookie': `${WINDOW_COOKIE}=${token}; Path=${ROUTE_PREFIX}/; HttpOnly; SameSite=Strict; Max-Age=${String(maxAgeSeconds)}`,
          'cache-control': 'no-store',
        })
        res.end()
        return
      }

      // Everything below is the sub-interface itself, so it needs a credential:
      // this app's session (in-app frame and its WebSocket) or a browser-window
      // session. A bare local request no longer reaches a child host.
      if (!service.admitsMount(req, id)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end('multiview: this sub-interface needs the app session (the in-app frame) or a browser-window ticket. Open it from the tab bar.\n')
        return
      }

      // A relative URL is resolved against `document.baseURI`, which is the
      // child's own mount only when the mount ends in a slash. Redirect the
      // bare form so every relative URL inside the child stays inside it.
      if (rest === undefined || rest === '') {
        const query = url.search === '' ? '' : url.search
        res.writeHead(308, { location: `${ROUTE_PREFIX}/${id}/${query}`, 'cache-control': 'no-store' })
        res.end()
        return
      }

      const target = service.target(id)
      if (target === undefined) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(`multiview: sub-interface ${JSON.stringify(id)} is not running. Start it from the tab bar.\n`)
        return
      }

      const headers = { ...req.headers }
      delete headers.host
      delete headers.origin
      delete headers['sec-fetch-site']
      delete headers['accept-encoding']
      // Hop-by-hop headers end at this hop. Relaying `expect` in particular
      // breaks the child hop outright: undici's fetch rejects such a request
      // before it is sent, so a POST that carried one came back as 502
      // "unreachable" — and in the UI as "新建会话失败".
      for (const name of HOP_BY_HOP_HEADERS) delete headers[name]
      // `Connection` also nominates further hop-by-hop names, case-insensitively.
      const nominated = req.headers.connection
      if (typeof nominated === 'string') {
        for (const name of nominated.split(',')) {
          const trimmed = name.trim().toLowerCase()
          if (trimmed !== '') delete headers[trimmed]
        }
      }
      headers.cookie = target.cookie

      try {
        // The query string is forwarded verbatim: the plugin-bundle combo route
        // is `/plugins/??a&b&rev=…`, whose double question mark is significant.
        const response = await fetch(`${target.origin}${rest}${url.search}`, {
          method: req.method,
          headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
          duplex: 'half',
          redirect: 'manual',
        })
        const outgoing = {}
        for (const [key, value] of response.headers) {
          if (['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade'].includes(key.toLowerCase())) continue
          outgoing[key] = value
        }

        const contentType = response.headers.get('content-type') ?? ''
        if (contentType.startsWith('text/html') && service.mainOrigin !== undefined) {
          // The child document boots as a plain web client (the desktop preload
          // runs only in the top frame). Four things must be true before its
          // own scripts run:
          //
          //  1. Its transport points at this mount, so its Remote stream
          //     WebSocket resolves to a URL the shell's own request rewriting
          //     accepts, and it is marked as host-owned so loopback-only
          //     features stay enabled.
          //  2. Its Web Storage is namespaced. A child shares the page's origin
          //     (the shell serves every frame from one origin), so without this
          //     a child's client-side state would collide with the main
          //     interface's and with every other sub-interface's.
          //  3. Nothing else is touched: the child renders its own application,
          //     with its own plugins, exactly as a standalone client would.
          let html = await response.text()
          const mount = `${service.mainOrigin}${ROUTE_PREFIX}/${id}/`
          const namespace = `dsh-multiview:${id}:`
          // An optional session hint from the URL (see WINDOW_SESSION_QUERY).
          // Written through the shim installed just below, so it lands in this
          // sub-interface's own namespace, and only when it looks like a session
          // id — this is a URL parameter, so it must not be able to inject code.
          const hinted = (() => {
            const value = url.searchParams.get(WINDOW_SESSION_QUERY)
            return value !== null && /^session-[A-Za-z0-9-]{1,80}$/.test(value) ? value : null
          })()
          const injection = '<script>'
            + `globalThis.__DSH_TRANSPORT__={ownsHost:true,streamBaseUrl:${JSON.stringify(mount)}};`
            + '(function(){'
            + `var P=${JSON.stringify(namespace)};`
            + 'var wrap=function(store){'
            + 'if(!store||store.__mvWrapped)return store;'
            + 'var real={getItem:store.getItem.bind(store),setItem:store.setItem.bind(store),'
            + 'removeItem:store.removeItem.bind(store),clear:store.clear.bind(store),key:store.key.bind(store)};'
            + 'var own=function(){var out=[],n=real.length;'
            + 'for(var i=0;i<n;i++){var k=real.key(i);if(k&&k.indexOf(P)===0)out.push(k);}return out;};'
            + 'var shim={'
            + 'getItem:function(k){return real.getItem(P+String(k))},'
            + 'setItem:function(k,v){real.setItem(P+String(k),v)},'
            + 'removeItem:function(k){real.removeItem(P+String(k))},'
            + 'clear:function(){own().forEach(function(k){real.removeItem(k)})},'
            + 'key:function(i){var k=own()[i];return k===undefined?null:k.slice(P.length)},'
            + 'get length(){return own().length},'
            + '__mvWrapped:true};'
            + 'return shim;};'
            + 'try{'
            + 'var ls=wrap(window.localStorage),ss=wrap(window.sessionStorage);'
            + 'Object.defineProperty(window,"localStorage",{configurable:true,get:function(){return ls}});'
            + 'Object.defineProperty(window,"sessionStorage",{configurable:true,get:function(){return ss}});'
            + '}catch(e){console.warn("[dsh-multiview] storage isolation unavailable:",e)}'
            // 4. Point the client at the session this window was opened for. The
            //    client has no URL deep link, so its own "current session" entry
            //    is primed before its scripts run. Best-effort by design: if DSH
            //    ever renames the key, the window still opens — just at whichever
            //    session the client would have restored anyway.
            + 'try{'
            + `var S=${JSON.stringify(hinted)};`
            + 'if(S!==null)localStorage.setItem("dsh.sessions.current",JSON.stringify({sessionId:S}));'
            + '}catch(e){}'
            + '})();'
            + '</script>'
          html = html.replace(/<head(\s[^>]*)?>/i, (open) => `${open}${injection}`)
          const buffer = Buffer.from(html, 'utf8')
          outgoing['content-length'] = String(buffer.length)
          res.writeHead(response.status, outgoing)
          res.end(buffer)
          return
        }

        res.writeHead(response.status, outgoing)
        if (response.body === null) {
          res.end()
          return
        }
        for await (const chunk of response.body) res.write(chunk)
        res.end()
      } catch (error) {
        // "fetch failed" on its own says nothing about why. Name the transport
        // cause when there is one: `UND_ERR_NOT_SUPPORTED` means the request
        // itself was rejected (a relayed `Expect` used to do exactly that),
        // `ECONNREFUSED` means the child is gone, and `ECONNRESET` means the
        // connection died mid-request.
        const cause = error instanceof Error && error.cause instanceof Error && typeof error.cause.code === 'string'
          ? ` (${error.cause.code})`
          : ''
        const message = `multiview: sub-interface ${JSON.stringify(id)} is unreachable: ${error instanceof Error ? error.message : String(error)}${cause}`
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end(`${message}\n`)
        } else {
          res.destroy()
        }
      }
    },
  }), 'multiview: proxy route')

  ctx.logger('multiview').info('multiview: mounted at %s', ROUTE_PREFIX)
}
