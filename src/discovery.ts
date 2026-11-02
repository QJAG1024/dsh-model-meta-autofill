/**
 * The LLM discovery seam: this plugin describes the models a provider endpoint
 * advertises, so the rows a user adopts from a pull arrive already carrying
 * their catalog metadata.
 *
 * WHY A WRAP, NOT A REGISTRATION: `llm.registerModelDiscovery()` holds exactly
 * one discovery per settings namespace (`llm/src/index.ts` throws
 * `DUPLICATE_DISCOVERY` on a second), and `llm-pi-ai` — the family this plugin
 * serves — already owns `llm-pi-ai`. Discovery also has no waterfall and no
 * event, so there is no registration point to contribute through. The service
 * exposes `discoverModels()` as a public method, and the Remote adapter calls
 * it through `this` (`remoteDiscoverModels` → `this.discoverModels`), so an
 * instance-level wrap is observed by both direct and Remote callers.
 *
 * The wrap is removed by the disposer, and it restores an own property only
 * where one already existed: the method normally lives on the prototype, so
 * teardown deletes the shadow rather than leaving a copy behind. A wrap that
 * outlived its fiber would keep describing a torn-down plugin's index.
 *
 * @module dsh-model-meta-autofill/discovery
 */

import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'

/** The slice of the LLM runtime this seam consumes. */
export interface DiscoveryHost {
  /**
   * Interrogate one provider endpoint for the models it advertises.
   * @param settingsNs - namespace whose registered discovery serves this draft.
   * @param request - the endpoint, protocol, and one-shot credential to use.
   * @param signal - caller cancellation.
   * @returns the advertised models, deduplicated in endpoint order.
   */
  discoverModels(
    settingsNs: string,
    request: LlmModelDiscoveryRequest,
    signal?: AbortSignal,
  ): Promise<LlmDiscoveredModel[]>
}

/** How one wrap describes the candidates it is handed. */
export interface DiscoveryEnrichment {
  /**
   * The only settings namespace whose candidates are described. Another
   * family's discovery answers untouched: its rows are not this plugin's to
   * size.
   */
  settingsNs: string
  /**
   * Describe the candidates the endpoint advertised, in its own order. Called
   * after the underlying discovery resolves, and awaited before the caller
   * sees the answer, so an adopt action can never race the fill.
   * @param candidates - the models the endpoint advertised.
   * @returns the same candidates, in the same order, with gaps filled.
   */
  describe(candidates: readonly LlmDiscoveredModel[]): Promise<readonly LlmDiscoveredModel[]>
}

/**
 * Install the describing wrap over one LLM runtime's discovery.
 *
 * A failure inside `describe` propagates: a caller that cannot get described
 * candidates is better served by the discovery error than by adopting rows this
 * plugin silently failed to size.
 *
 * @param host - the LLM runtime whose discovery is wrapped.
 * @param enrichment - the namespace to describe and the describing pass.
 * @returns the disposer that restores the previous discovery.
 */
export function installDiscoveryEnrichment(
  host: DiscoveryHost,
  enrichment: DiscoveryEnrichment,
): () => void {
  // Captured before the wrap so teardown restores the exact previous state,
  // including whether the method was an own property at all.
  const own = Object.getOwnPropertyDescriptor(host, 'discoverModels')
  const base = host.discoverModels
  host.discoverModels = async function wrapped(
    this: DiscoveryHost,
    settingsNs: string,
    request: LlmModelDiscoveryRequest,
    signal?: AbortSignal,
  ): Promise<LlmDiscoveredModel[]> {
    const found = await base.call(this, settingsNs, request, signal)
    if (settingsNs !== enrichment.settingsNs) return found
    return [...await enrichment.describe(found)]
  }
  return () => {
    if (own !== undefined) {
      Object.defineProperty(host, 'discoverModels', own)
      return
    }
    // The method came from the prototype, so removing the shadow is the exact
    // restoration; `Reflect` keeps this a plain delete rather than a cast.
    Reflect.deleteProperty(host, 'discoverModels')
  }
}
