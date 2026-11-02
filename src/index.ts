/**
 * dsh-model-meta-autofill
 *
 * A DSH host plugin that fills metadata (context length, output cap, display
 * name, input modalities) for the models of custom provider routes configured
 * in the `llm-pi-ai` settings section, from the model catalogs (models.dev by
 * default).
 *
 * Behavior:
 *
 * - A bundled offline index (src/data/*.json) answers immediately, offline.
 * - An optional live refresh merges the latest catalogs over it at start (and
 *   on an interval), failing per-source without touching the rest.
 * - When a provider endpoint is interrogated for the models it serves, the
 *   candidates come back with the catalog's capacities and display names
 *   filled in, so the rows a user adopts already carry their metadata. Only
 *   ABSENT fields are filled: a capacity the endpoint disclosed is kept, and a
 *   model the catalog does not know is returned untouched.
 * - `ctx.modelMeta` exposes the index and the pure helpers to other plugins.
 *
 * The plugin WRITES NO SETTINGS. Fill happens on the discovery answer, and the
 * adopted rows reach the document through the editor's own 保存 like any other
 * edit — so a model the catalog cannot answer for, and any unsaved work in an
 * open card, are never touched by this plugin. It also never starts a model:
 * discovery reports what an endpoint serves, and this only describes those
 * answers.
 *
 * @module dsh-model-meta-autofill
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: the Context.settings augmentation and the descriptor view it returns.
import type { SettingsDescriptor } from '@deepseek-ai/dsh-settings'
// Type-only: the Context.llm augmentation ships with this package.
import type {} from '@deepseek-ai/dsh-llm'
// Type-only import: the Context.webServer augmentation ships with this package.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import {
  catalogViews, listProviders, sendJson, type NameStyle,
} from './api.ts'
import type { Config } from './config.ts'
import { DEFAULT_BASE_URL, resolveConfig, TARGET_NAMESPACE } from './config.ts'
import {
  loadBundledIndex,
  ModelMetaIndex,
  refreshLive,
  sourceId,
  type LookedUpEntry,
} from './dataset.ts'
import { installDiscoveryEnrichment } from './discovery.ts'
import {
  buildSectionPatch,
  enrichDiscovered,
  type EnrichOptions,
  type LlmPiAiSection,
} from './enrich.ts'
import type { ModelMetaService } from './service.ts'

export { createModelMetaService, type ModelMetaService } from './service.ts'
export { DEFAULT_BASE_URL, DEFAULT_SOURCES, resolveConfig, TARGET_NAMESPACE } from './config.ts'
export type { Config } from './config.ts'
export {
  ModelMetaIndex,
  collectEntries,
  normalizeEntry,
  refreshLive,
  type CatalogEntry,
  type LookedUpEntry,
  type RefreshResult,
} from './dataset.ts'
export {
  buildSectionPatch,
  cleanEntry,
  enrichEntry,
  fillsFor,
  listMissing,
  type EnrichOptions,
  type LlmPiAiSection,
  type ModelEntry,
  type ProviderProfile,
} from './enrich.ts'

export const name = 'dsh-model-meta-autofill'

/**
 * The slice of the `settings` service this plugin consumes. The service is a
 * read/write seam over profile patch entries: `describe()` projects every
 * active entry's resolved value, and `update()` merges a patch into the user
 * layer of one entry, fenced by the revision the caller last read.
 */
interface SettingsLike {
  describe(options?: { redactSecrets?: boolean }): SettingsDescriptor[]
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
}

/** The llm-pi-ai entry's descriptor, or undefined while its owner is not active. */
function descriptorOf(settings: SettingsLike): SettingsDescriptor | undefined {
  try {
    return settings.describe().find((entry) => String(entry.ns) === TARGET_NAMESPACE)
  } catch (error) {
    // A describe() that throws (no profile yet, torn-down editor) means "not
    // served yet": callers retry or do nothing rather than failing the boot.
    // The service is a live seam, so its availability genuinely varies.
    void error
    return undefined
  }
}

/**
 * The provider routes present in the user's own settings layer. Without an
 * authoritative user view nothing is reported — an empty set keeps
 * composition-base-only providers from ever being materialized.
 */
export function userProviderIdsOf(sctx: { settings: SettingsLike }): ReadonlySet<string> {
  try {
    const descriptor = sctx.settings.describe({ redactSecrets: true })
      .find((entry) => String(entry.ns) === TARGET_NAMESPACE)
    const user = descriptor?.user as { providers?: Record<string, unknown> } | null | undefined
    const providers = user?.providers
    return providers === undefined
      ? new Set<string>()
      : new Set(Object.keys(providers))
  } catch {
    return new Set<string>()
  }
}

/** The resolved `llm-pi-ai` section, or undefined while it is not served. */
function sectionOf(settings: SettingsLike): LlmPiAiSection | undefined {
  const value = descriptorOf(settings)?.value
  return value === null || typeof value !== 'object' ? undefined : value as LlmPiAiSection
}

export function apply(ctx: Context, rawConfig?: Partial<Config>): void {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) {
    ctx.logger.info('dsh-model-meta-autofill: disabled by config')
    return
  }
  const enrichOptions: EnrichOptions = {
    fillName: config.fillName,
    fillInput: config.fillInput,
    // fillReasoning is reserved (pi-ai stores nothing dialect-free today).
  }

  // The shared index: bundled snapshots first, live refresh merged over them.
  // The load is memoized so an enrichment pass can await it: running the pass
  // before the index is ready would find nothing and silently skip a section
  // that still needs filling.
  const index = new ModelMetaIndex([])
  let bundledPromise: Promise<void> | undefined
  const ensureBundled = (): Promise<void> => {
    bundledPromise ??= loadBundledIndex(config.sources.map(sourceId)).then((result) => {
      // Merge the freshly loaded snapshots into the shared index this plugin
      // serves lookups from (bundled first, live refresh merged over it later).
      index.mergeFrom(result.index)
      for (const error of result.errors) {
        ctx.logger.warn('dsh-model-meta-autofill: bundled catalog "%s" failed to load: %s', error.source, error.message)
      }
    })
    return bundledPromise
  }
  void ensureBundled().then(() => {
    if (config.refreshOnStart) {
      void refreshLive(index, config.sources, DEFAULT_BASE_URL, config.timeoutMs).then((result) => {
        reportRefresh(ctx, result)
      })
    }
  })

  // Web surface: the read-only endpoints behind the Models-page controls. Only
  // mounts when the web profile provides the web server — headless boots simply
  // never activate it.
  ctx.inject(['settings', 'webServer'], (sctx) => {
    const settings: SettingsLike = sctx.settings
    const section = (): LlmPiAiSection | undefined => sectionOf(settings)
    const lookupIndex = (id: string): LookedUpEntry | undefined => index.lookup(id)
    sctx.effect(() => {
      const disposers = [
        sctx.webServer.register({
          kind: 'exact',
          path: '/model-meta-autofill/api/providers',
          handler: (_req, res) => {
            sendJson(res, 200, { providers: listProviders(section(), userProviderIdsOf(sctx)) })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: '/model-meta-autofill/api/catalog',
          handler: (req, res) => {
            // A READ: the controls fill the editor's own fields with this and let
            // the card's 保存 commit, so nothing is written here and an open
            // draft is never invalidated.
            const query = new URL(req.url ?? '/', 'http://localhost').searchParams
            // `ids` is a comma-separated list, so a provider-level fill covering
            // every row is ONE round trip rather than one request per model.
            const ids = (query.get('ids') ?? '').split(',').map((id) => id.trim()).filter((id) => id !== '')
            if (ids.length === 0) {
              sendJson(res, 400, { ok: false, reason: 'ids is required' })
              return
            }
            const nameStyle: NameStyle = query.get('nameStyle') === 'vendor' ? 'vendor' : 'bare'
            sendJson(res, 200, catalogViews(lookupIndex, ids, nameStyle))
          },
        }),
      ]
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-model-meta-autofill.web-api')
  })

  // Host service: index + pure helpers for other plugins/surfaces.
  const service: ModelMetaService = {
    lookup: (id) => index.lookup(id),
    stats: () => {
      return {
        sourceCount: config.sources.length,
        entryCount: index.size,
      }
    },
    refresh: async () => {
      await ensureBundled()
      const result = await refreshLive(index, config.sources, DEFAULT_BASE_URL, config.timeoutMs)
      reportRefresh(ctx, result)
      return result
    },
    buildSectionPatch: (section, optionsPatch, userProviderIds) =>
      buildSectionPatch(
        section,
        (id) => index.lookup(id),
        { ...enrichOptions, ...optionsPatch },
        userProviderIds,
      ),
  }
  ctx.provide('modelMeta', service)
  if (config.refreshIntervalMs > 0) {
    // Plain timers wrapped in an effect disposer, so the plugin needs no
    // timer-plugin dependency and stays testable on a bare context.
    ctx.effect(() => {
      const id = setInterval(() => {
        void service.refresh().catch(() => { /* per-source failures are reported inside refresh */ })
      }, config.refreshIntervalMs)
      return () => clearInterval(id)
    }, 'dsh-model-meta-autofill.refresh-interval')
  }

  // The discovery seam: describe the models a provider endpoint advertises, so
  // the rows a user adopts from a pull arrive carrying their catalog metadata
  // and need no separate fill pass. Nothing is written here — the adopted rows
  // reach settings through the editor's own 保存, exactly like a hand-typed row.
  //
  // `ctx.inject` keeps the plugin mountable without an LLM service: on a boot
  // that has none, this seam simply never activates and `ctx.modelMeta` plus the
  // web API remain available.
  ctx.inject(['llm'], (sctx) => {
    sctx.effect(() => {
      // `ctx.get` reads the service INSTANCE; `ctx.llm` is a context Proxy whose
      // `set` trap routes to service registration, so wrapping through it would
      // silently register nothing and the Remote adapter — which calls
      // `this.discoverModels` on the real instance — would never see the wrap.
      const host = sctx.get('llm')
      // The read is optional by type; `inject` already waited for it, so an
      // absent service means the provider went away between wait and effect.
      if (host === undefined) return () => {}
      return installDiscoveryEnrichment(host, {
        settingsNs: TARGET_NAMESPACE,
        describe: async (candidates) => {
          await ensureBundled()
          if (candidates.length === 0) return candidates
          const described = enrichDiscovered(candidates, (id) => index.lookup(id), enrichOptions)
          const filled = described.filter((model, at) => !deepEqualJson(model, candidates[at])).length
          if (filled > 0) {
            ctx.logger.info(
              'dsh-model-meta-autofill: described %d of %d discovered model(s) from the catalog',
              filled,
              candidates.length,
            )
          }
          return described
        },
      })
    }, 'dsh-model-meta-autofill.discovery')
  })
}

/** Log one live-refresh outcome compactly. */
function reportRefresh(ctx: Context, result: { ok: boolean; refreshed: string[]; errors: { source: string; message: string }[] }): void {
  if (result.ok) {
    ctx.logger.info('dsh-model-meta-autofill: live refresh merged %d catalog(s): %s', result.refreshed.length, result.refreshed.join(', '))
    return
  }
  const failed = result.errors.map((e) => `${e.source} (${e.message})`).join('; ')
  ctx.logger.warn('dsh-model-meta-autofill: live refresh partially failed: %s — serving bundled snapshots', failed)
}
