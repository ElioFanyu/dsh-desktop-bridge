/**
 * Host entry point for `dsh-desktop-bridge`.
 *
 * The plugin has exactly one job: when a session starts waiting for you, or when
 * it finishes, show a Windows notification in the bottom-right corner of the
 * screen. Everything it needs is in this one host process:
 *
 *   lib/index.js      this file — route registration and lifecycle only
 *   lib/ingest.js     the HTTP door the browser half knocks on
 *   lib/notifier.js   session events -> toasts, throttling, AUMID warm-up
 *   lib/host/*        the Windows plumbing (toast worker, focus check, AUMID)
 *
 * There is no companion desktop process any more, so there is no second port, no
 * discovery file, and nothing to start by hand. See README for why.
 */

import { HEALTH_PATH, INGEST_PATH, PROBE_PATH } from './host/constants.js'
import { NOTIFY_KINDS } from './host/protocol.js'
import { log as logToFile } from './host/state.js'
import { createIngest } from './ingest.js'
import { createNotifier } from './notifier.js'

export const name = 'dsh-desktop-bridge'

/** The web server is the transport; without it there is no bridge. */
export const inject = ['webServer']

export function apply(ctx) {
  const log = (msg) => {
    // Two sinks on purpose. The file is the one the README tells people to read
    // (`notifier.log`), and it is the only sink that survives the GUI: a packaged
    // desktop launch has no console attached to the host child. The cordis logger
    // is kept so the line also lands in DSH's own startup diagnostics.
    //
    // cordis 4.1's logger is a callable service exposing info/warn/error/debug —
    // `logger.log` never existed there, and `logger` is not a plain object. Try
    // the methods in order and fall back to the console, so a host that reshapes
    // its logger degrades to "still logged", never to "silently nothing".
    try {
      logToFile(msg)
    } catch {
      /* the file sink never throws, but a broken profile must not stop logging */
    }
    for (const fn of ['info', 'log', 'debug']) {
      try {
        const emit = ctx?.logger?.[fn]
        if (typeof emit === 'function') {
          emit.call(ctx.logger, msg)
          return
        }
      } catch {
        /* logging must never throw */
      }
    }
    try {
      console.log(`[desktop-bridge] ${msg}`)
    } catch {
      /* ignore */
    }
  }

  const webServer = ctx?.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    log('notifier: no webServer service; notifications inactive')
    return
  }

  const notifier = createNotifier({ log })

  const ingest = createIngest({
    handleEvent: (ev) => notifier.handle(ev),
    log,
    stats: () => notifier.stats(),
  })

  /** @type {Array<() => void>} */
  const disposers = []

  const routes = [
    { kind: 'exact', path: INGEST_PATH, handler: ingest.handleIngest },
    { kind: 'exact', path: HEALTH_PATH, handler: ingest.handleHealth },
    { kind: 'exact', path: PROBE_PATH, handler: ingest.handleProbe },
  ]

  for (const route of routes) {
    try {
      disposers.push(webServer.register(route))
    } catch (err) {
      // A duplicate route means another instance already owns this path. Keep the
      // routes that did register and report, rather than throwing out of apply —
      // an exception here would fail the whole browser bundle too.
      log(`notifier: cannot register ${route.path}: ${err?.message ?? err}`)
    }
  }

  // The token has to reach the page before the browser half can post anything.
  // `webserver/index-inject` is emitted by the web server's own context once per
  // index render, so the listener belongs to that context, not to this plugin's.
  //
  // The second argument is the Peer the page speaks for (added in DSH 0.2.2).
  // This half renders the same row for every Peer: the token authenticates the
  // route, and per-Peer rows are the caller's business, not ours.
  const listener = (table) => {
    if (!Array.isArray(table)) return
    table.push({
      kind: 'global',
      name: '__DSH_DESKTOP_BRIDGE__',
      value: {
        token: ingest.token,
        protocol: 1,
        // Which kinds this half understands. The browser bundle can be newer
        // than the host process that is already running — a page refresh picks
        // up lib/client.js immediately, while the host half needs a restart. A
        // newer client must not post a kind this host would drop as malformed,
        // because that turns a failure into silence instead of a wrong label.
        kinds: NOTIFY_KINDS,
        // The browser half only streams its view of session state when asked; it
        // learns whether it was asked from here, so flipping the setting is one
        // file edit plus a restart instead of a rebuild.
        debug: notifier.settings?.debug === true,
      },
    })
  }
  // Subscribe on this plugin's own context: cordis scopes every listener to the
  // fiber that registered it and disposes it on unload, and the event bus is
  // shared across a tree, so an emit from the web server's context still lands
  // here. `webServer.ctx` stays as the fallback for a host that isolates buses.
  try {
    const bus = typeof ctx?.on === 'function' ? ctx : webServer.ctx
    if (typeof bus?.on === 'function') {
      // `ctx.on()` returns the disposer for exactly this listener. cordis 4.1 has
      // no `ctx.off` at all (the event mixin is on/once/parallel/emit/serial/
      // bail/waterfall), so the old `bus.off?.(...)` teardown was a no-op: the
      // listener outlived dispose and kept pushing a stale token into every index
      // render. Use the returned disposer, and keep `off` only as a last resort.
      const off = bus.on('webserver/index-inject', listener)
      disposers.push(
        typeof off === 'function'
          ? off
          : () => {
              try {
                bus.off?.('webserver/index-inject', listener)
              } catch {
                /* ignore */
              }
            },
      )
    } else {
      log('notifier: no event bus; the browser half will have no token')
    }
  } catch (err) {
    log(`notifier: cannot subscribe to index injection: ${err?.message ?? err}`)
  }

  notifier.start()

  const dispose = () => {
    for (const off of disposers) {
      try {
        off()
      } catch {
        /* ignore */
      }
    }
    disposers.length = 0
    notifier.dispose()
  }

  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => dispose, 'dsh-desktop-bridge: routes')
    } catch (err) {
      log(`notifier: cannot register dispose effect: ${err?.message ?? err}`)
    }
  }

  return dispose
}
