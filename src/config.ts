/**
 * Plugin configuration for dsh-model-meta-autofill.
 *
 * The plugin enriches DSH custom-provider model metadata (context length,
 * output cap, display name, input modalities) from the model metadata
 * catalogs — models.dev (the Model Metadata Registry) by default, with the
 * PublicProviderConf dist catalogs still available — and persists the fills
 * into the `llm-pi-ai` user settings section, so a custom OpenAI-compatible
 * gateway's models carry the capacities its adapter needs without hand-entry.
 *
 * Every knob is optional; the defaults make the plugin work out of the box.
 *
 * @module dsh-model-meta-autofill/config
 */

import z from '@deepseek-ai/schemastery'

/**
 * Default catalog sources: the Model Metadata Registry (models.dev) alone —
 * it is standard, actively maintained, and covers the full model set. Named
 * PublicProviderConf dist ids and full file URLs remain available as opt-in
 * extra sources for gateways with exotic spellings.
 */
export const DEFAULT_SOURCES = ['models.dev'] as const

/** GitHub raw base for the live refresh of PublicProviderConf dist catalogs. */
export const DEFAULT_BASE_URL =
  'https://raw.githubusercontent.com/ThinkInAIXYZ/PublicProviderConf/main/dist/'

/** Settings namespace the llm-pi-ai adapter owns; this plugin fills its section. */
export const TARGET_NAMESPACE = 'llm-pi-ai'

/** Plugin configuration. */
export interface Config {
  /** Master switch; false keeps the plugin mounted but inert. Default true. */
  enabled: boolean
  /**
   * Catalog sources to merge, in priority order — a model found by a later
   * source wins. `models.dev` is the standard Model Metadata Registry
   * (https://models.dev/api.json); PublicProviderConf dist ids (e.g.
   * `aihubmix`) and full file URLs also work when opted in.
   * Default ['models.dev'].
   */
  sources: string[]
  /** HTTP request timeout for live refreshes, in milliseconds. Default 15000. */
  timeoutMs: number
  /** Refresh the merged index from the network at plugin start. Default true. */
  refreshOnStart: boolean
  /**
   * Repeat the live refresh every `refreshIntervalMs` milliseconds;
   * 0 disables repeating. Default 0 (fetch once, then offline).
   */
  refreshIntervalMs: number
  /** Fill the display name when the catalog carries a prettier one. Default true. */
  fillName: boolean
  /** Fill input modalities (adds 'image' for vision-capable models). Default true. */
  fillInput: boolean
  /**
   * Fill reasoning capability markers (best-effort; pi-ai stores nothing
   * dialect-free today, so the field is reserved and currently no-ops).
   * Default false.
   */
  fillReasoning: boolean
}

const configSchema = z.object({
  enabled: z.boolean().default(true),
  sources: z.array(z.string()).default([...DEFAULT_SOURCES]),
  timeoutMs: z.number().step(1).min(1000).default(15000),
  refreshOnStart: z.boolean().default(true),
  refreshIntervalMs: z.number().step(1).min(0).default(0),
  fillName: z.boolean().default(true),
  fillInput: z.boolean().default(true),
  fillReasoning: z.boolean().default(false),
})

/** Resolve raw entry config into a validated {@link Config}. */
export function resolveConfig(raw: Partial<Config> | undefined): Config {
  let checked: Config
  try {
    checked = configSchema(raw ?? {}) as Config
  } catch (error) {
    // The loader also validates entry config; reaching here with an invalid
    // entry means a programmatic mount — fail loud with the plugin named.
    throw new Error(`dsh-model-meta-autofill: invalid config: ${(error as Error).message}`)
  }
  if (!Array.isArray(checked.sources) || checked.sources.length === 0) {
    throw new Error('dsh-model-meta-autofill: sources must name at least one catalog (models.dev, a PublicProviderConf dist id, or an http(s) URL)')
  }
  return checked
}
