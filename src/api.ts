/**
 * Host web surface for dsh-model-meta-autofill: the read-only endpoints behind
 * the Models-page "自动获取" controls (or any local caller). They answer with the
 * catalog values for the models the page names and write nothing — the controls
 * put those values into the editor's own fields and the card's 保存 commits
 * them, so a user's unsaved work is never clobbered by an external write.
 *
 * Loopback-only in practice (the web profile binds 127.0.0.1); the routes answer
 * JSON.
 *
 * Routes (exact, registered on ctx.webServer with the settings service):
 *
 *   GET /model-meta-autofill/api/providers     -> { providers: [{ provider, displayName, models }] }
 *   GET /model-meta-autofill/api/catalog?ids=a,b -> { ok, models, unknown }
 *
 * @module dsh-model-meta-autofill/api
 */

import type { ServerResponse } from 'node:http'
import type { LookedUpEntry } from './dataset.ts'
import type { LlmPiAiSection } from './enrich.ts'

export type { LlmPiAiSection }

/** How a synced display name is written. */
export type NameStyle = 'vendor' | 'bare'

/**
 * Split a catalog display name into its vendor label and bare model name.
 * models.dev official listings carry clean names plus a maker vendor; gateway
 * listings sometimes bake the vendor into the name ("OpenAI/GPT-5.2") — that
 * prefix is recovered as the vendor when no explicit one is known.
 * @param name - the catalog display name.
 * @param vendor - the catalog's maker label, when it has one.
 * @returns the recovered vendor and bare name, each absent when unknown.
 */
export function splitVendorName(
  name: string | undefined,
  vendor: string | undefined,
): { vendor?: string; bare?: string } {
  if (name === undefined) return {}
  let bare = name
  let inferred = vendor
  const slash = name.indexOf('/')
  if (slash > 0 && slash < name.length - 1) {
    const prefix = name.slice(0, slash).trim()
    const rest = name.slice(slash + 1).trim()
    if (prefix !== '' && rest !== '') {
      bare = rest
      if (inferred === undefined) inferred = prefix
    }
  }
  return { ...inferred === undefined ? {} : { vendor: inferred }, bare }
}

/**
 * The display name a fill writes, honoring the vendor-prefix style.
 * @param meta - the catalog entry.
 * @param style - `bare` for the plain name, `vendor` to prefix the maker.
 * @returns the display name, or undefined when the catalog carries none.
 */
export function displayName(
  meta: { name?: string; vendor?: string },
  style: NameStyle,
): string | undefined {
  const parts = splitVendorName(meta.name, meta.vendor)
  if (parts.bare === undefined) return undefined
  if (style === 'vendor' && parts.vendor !== undefined) return `${parts.vendor}: ${parts.bare}`
  return parts.bare
}

/** One model row as the settings editor renders it. */
export interface ProviderModelView {
  /** The model id, shown in the row's first input. */
  id: string
  /** The display name the row's second input holds, when the profile declares one. */
  name?: string
  /** The context window the row's capacity input should hold. */
  contextWindow?: number
  /** The output cap the row's capacity input should hold. */
  maxTokens?: number
}

/** One provider route with the label the Models page renders on its card. */
export interface ProviderIdentityView {
  /** The route id the settings document keys the profile by. */
  provider: string
  /** The card's visible title, which is not always the route id. */
  displayName: string
  /** The route's configured models, in document order. */
  models: ProviderModelView[]
}

/**
 * List the user-layer provider routes with their card titles and models.
 *
 * The browser half injects into rendered cards, whose DOM carries only the
 * title, so it needs this map to recover the route id a control must name. The
 * rows travel too: the per-model control reads them to know which model ids a
 * provider-level fill should ask the catalog about.
 *
 * @param section - the resolved llm-pi-ai section, when its owner is active.
 * @param userProviderIds - routes present in the user's own layer, which are the
 *   only ones the controls offer; undefined means every route in the section.
 * @returns one entry per addressed route, in document order.
 */
export function listProviders(
  section: LlmPiAiSection | undefined,
  userProviderIds: ReadonlySet<string> | undefined,
): ProviderIdentityView[] {
  const providers = section?.providers
  if (providers === undefined) return []
  const out: ProviderIdentityView[] = []
  for (const [provider, profile] of Object.entries(providers)) {
    if (userProviderIds !== undefined && !userProviderIds.has(provider)) continue
    if (profile === null || typeof profile !== 'object') continue
    const declared = profile.displayName
    const models: ProviderModelView[] = []
    for (const raw of profile.models ?? []) {
      if (raw === null || typeof raw !== 'object') continue
      const id = raw.id
      if (typeof id !== 'string' || id === '') continue
      models.push({
        id,
        ...typeof raw.name === 'string' && raw.name !== '' ? { name: raw.name } : {},
        ...typeof raw.contextWindow === 'number' ? { contextWindow: raw.contextWindow } : {},
        ...typeof raw.maxTokens === 'number' ? { maxTokens: raw.maxTokens } : {},
      })
    }
    out.push({
      provider,
      displayName: typeof declared === 'string' && declared !== '' ? declared : provider,
      models,
    })
  }
  return out
}

/** One model's catalog values, as a control fills them into the form. */
export interface CatalogView {
  /** The model id that was asked about. */
  id: string
  /** The display name to put in the row, when the catalog has one. */
  name?: string
  /** The context window to put in the row. */
  contextWindow?: number
  /** The output cap to put in the row. */
  maxTokens?: number
  /** The input modalities to tick in the row. */
  input?: ('text' | 'image')[]
}

/**
 * Answer with one model's fillable catalog values, writing nothing.
 *
 * A field the catalog does not know is ABSENT rather than present-and-empty: the
 * caller leaves that input alone, so an empty value can never clear something
 * the user set.
 *
 * @param lookup - catalog lookup by model id.
 * @param id - the model to describe.
 * @param nameStyle - how the display name is spelled.
 * @returns the fillable values, or undefined when the catalog does not know it.
 */
export function catalogView(
  lookup: (id: string) => LookedUpEntry | undefined,
  id: string,
  nameStyle: NameStyle = 'bare',
): CatalogView | undefined {
  const meta = lookup(id)
  if (meta === undefined) return undefined
  const name = displayName(meta, nameStyle)
  return {
    id,
    ...name === undefined ? {} : { name },
    ...meta.contextWindow === undefined ? {} : { contextWindow: meta.contextWindow },
    ...meta.maxTokens === undefined ? {} : { maxTokens: meta.maxTokens },
    ...meta.input === undefined ? {} : { input: [...meta.input] },
  }
}

/** The batch answer one provider-level fill uses for all of its rows at once. */
export interface CatalogBatchView {
  ok: true
  /** The models the catalog knows, keyed by the id that was asked about. */
  models: Record<string, CatalogView>
  /** The ids the catalog does not know, in the order they were asked about. */
  unknown: string[]
}

/**
 * Answer for many model ids in one round trip.
 *
 * A provider-level fill covers every row of a card, so asking per row would put
 * a request per model on the critical path of a single button press. Ids are
 * de-duplicated, and a blank id is skipped rather than reported as unknown: a
 * row the user has not named yet is not a catalog gap.
 *
 * @param lookup - catalog lookup by model id.
 * @param ids - the model ids to describe, in row order.
 * @param nameStyle - how display names are spelled.
 * @returns the known models and the ids the catalog does not know.
 */
export function catalogViews(
  lookup: (id: string) => LookedUpEntry | undefined,
  ids: readonly string[],
  nameStyle: NameStyle = 'bare',
): CatalogBatchView {
  const models: Record<string, CatalogView> = {}
  const unknown: string[] = []
  for (const id of ids) {
    if (id === '' || models[id] !== undefined || unknown.includes(id)) continue
    const view = catalogView(lookup, id, nameStyle)
    if (view === undefined) unknown.push(id)
    else models[id] = view
  }
  return { ok: true, models, unknown }
}

/* ---------------------------------------------------------------- HTTP --- */

/** Write a JSON response. */
export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}
