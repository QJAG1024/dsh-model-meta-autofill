/**
 * dsh-model-meta-autofill — browser half.
 *
 * Two controls, both labelled "自动获取", attached to the Models settings page:
 *
 * - the provider control, in the 模型目录 header of a card beside 恢复默认模型 and
 *   获取可用模型. It fills EVERY model row of that card.
 * - the per-model control, in one model row's 输入类型 line inside the editor.
 *   It fills only that row.
 *
 * Both are pure FORM FILLS: they read the catalog and write the values into the
 * editor's own inputs, leaving the card's 保存 to commit. Nothing is written to
 * settings behind the form, which is what keeps the two properties this feature
 * needs:
 *
 * - a model the catalog cannot answer for is never touched, so a user's own
 *   entries and edits to such models survive untouched;
 * - no external write ever invalidates the revision the open card's 保存 is
 *   fenced by, so the card stays savable and never has to be reloaded.
 *
 * The earlier design wrote settings directly and then reopened the card to show
 * the result. Reopening discarded unsaved work, and refreshing in place instead
 * would have meant reaching into React's private fiber internals — it works
 * (probed: the draft setter repaints, and a refreshed revision keeps 保存
 * working) but it depends on hook order and shape through `__reactFiber$`, so a
 * React or harness upgrade could break it silently. Filling the form needs none
 * of that.
 *
 * FILLING A CONTROLLED FIELD: React tracks an input's last rendered value on the
 * node itself, so assigning `input.value` makes React treat the next change as a
 * no-op and the draft silently keeps the old value — the field looks filled and
 * 保存 writes nothing. The fill therefore goes through the native value setter to
 * clear that tracker, then dispatches the `input` event React listens for. The
 * same technique the neighbouring reasoning-effort plugin uses on this page, and
 * `tests/client-injection.spec.ts` models React's tracker so a regression to
 * plain assignment fails there.
 *
 * WHY DOM INJECTION, NOT A SLOT: the per-card extension seat,
 * `settings.models.provider-card`, is a *keyed* slot, and a keyed cell holds
 * exactly one entry — a second registration at the same key and priority throws,
 * failing this plugin's fiber. Other plugins already claim that cell for this
 * adapter family, so registering into it is not available. The card supplies no
 * other per-card seat, and no seat exists inside the editor at all, so both
 * controls attach to the rendered DOM and follow it with a MutationObserver.
 *
 * Contract constraints (client-modules): no static imports — everything is
 * taken from the loader's module table via the injected require. Everything the
 * bundle needs is declared INSIDE the require-factory, never at the top level:
 * the host serves `lib/client.js` as a classic script, a combo concatenates
 * several packages into one script, and the loader re-executes a bundle to
 * invalidate it. Classic scripts share one global lexical environment per
 * document, so a top-level `const`/`let`/`class` is declared once for the whole
 * page and the next evaluation fails to COMPILE with "Identifier 'X' has
 * already been declared" — a failure that fires no `error` event, leaving the
 * loader to report `loaded without registering`. `tests/client-bundle.spec.ts`
 * executes the built bundle twice in one realm to hold this line.
 *
 * @module dsh-model-meta-autofill/client
 */

interface ModuleLoader {
  load(handoff: { id: string; factory: (require: (spec: string) => unknown) => Record<string, unknown> }): void
}
interface DshWindow { __ModuleLoader__: ModuleLoader }

/** The host's provider list: the route ids and rows behind the rendered cards. */
interface ProviderIdentityView {
  provider: string
  displayName: string
  models?: { id: string }[]
}
/** One model's catalog values, as a fill writes them into the form. */
interface CatalogView {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: ('text' | 'image')[]
}
/** The host's read-only answer for a batch of model ids. */
interface CatalogBatchResponse {
  ok?: boolean
  models?: Record<string, CatalogView>
  unknown?: string[]
  reason?: string
}

;(window as unknown as DshWindow).__ModuleLoader__.load({
  id: 'dsh-model-meta-autofill',
  factory: () => {
    const API = '/model-meta-autofill/api'
    const STYLE_ID = 'dsh-model-meta-autofill'
    // Class names are matched fuzzily: CSS modules hash the prefix but keep the
    // authored suffix (`_3nPmjq_rowCard`), so a full name cannot be hardcoded.
    const MARK = 'dmaSync'
    const CARD_SELECTORS = ['[class*="rowCard"]', '[class*="setupCard"]']
    const EDITOR_TITLE_SELECTOR = '[class*="editorTitle"]'
    const EDITOR_ROUTE_SELECTOR = '[class*="editorRoute"]'
    const HEAD_SELECTOR = '[class*="rowHead"]'
    const NAME_SELECTOR = '[class*="rowName"]'
    // The 模型目录 heading line: 恢复默认模型 / 获取可用模型 live here, and this is
    // the line the provider-level control joins. Its presence also means the
    // editor is open, and therefore that model rows and their inputs exist.
    const LIST_HEAD_SELECTOR = '[class*="modelListHead"]'
    // One model row, and the 输入类型 line inside its expanded body.
    const ENTRY_SELECTOR = '[class*="modelEntry"]'
    const ADVANCED_SELECTOR = '[class*="modelAdvanced"]'
    const INPUT_CHOICES_SELECTOR = '[class*="modelInputChoices"]'
    // Expansion and deletion share iconButton; only expansion has aria-expanded.
    const ROW_TOGGLE_SELECTOR = 'button[aria-expanded]'
    // Field labels from ui-settings-models 0.2.1-rc.5 in its English and Chinese locales.
    // The editor appends the one-based row position.
    const MODEL_ID_LABEL_PREFIXES = ['Model ID', '模型 ID']
    const MODEL_NAME_LABEL_PREFIXES = ['Display name', '显示名称']
    const CONTEXT_WINDOW_LABEL_PREFIXES = ['Context window', '上下文窗口']
    const MAX_TOKENS_LABEL_PREFIXES = ['Max output tokens', '最大输出']
    /** How long to wait for a React commit before giving up on it. */
    const COMMIT_TIMEOUT_MS = 2000
    /** Poll interval while waiting for a commit; one frame at 60 Hz. */
    const COMMIT_POLL_MS = 16
    // How long a result bubble stays up. A refusal or a failure is worth reading
    // for longer than a confirmation.
    const BUBBLE_MS_OK = 3200
    const BUBBLE_MS_ATTENTION = 6500
    const CSS_TEXT = [
      // Inline, in the heading line and the 输入类型 line: no wrap so the control
      // never pushes the row's own content onto another line.
      '.dma-sync { display: inline-flex; align-items: center; gap: 8px; }',
      // Per-model: pushed to the end of the 输入类型 line, clear of the checkboxes.
      '.dma-sync--row { margin-left: auto; }',
      // Sized and colored like the page's own inline actions (`linkButton`), so
      // it sits beside 恢复默认模型 / 获取可用模型 without looking foreign.
      '.dma-syncButton { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 28px; padding: 0 10px; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }',
      '.dma-syncButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }',
      '.dma-syncButton:disabled { cursor: default; opacity: 0.4; }',
      '.dma-syncButton:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }',
      // The result bubble, matching the app's own tooltip (ui-primitives
      // Tooltip.module.css) so it reads as part of the page. It is positioned
      // out of flow, so it cannot disturb the line it was opened from.
      '.dma-bubble { position: fixed; z-index: 1100; width: max-content; max-width: 50vw; padding: 3px 7px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-tooltip-bg); color: var(--dsw-static-neutral-bluish-00); font-size: 13px; line-height: 20px; white-space: pre-line; overflow-wrap: break-word; pointer-events: none; box-shadow: var(--dsw-shadow-lv2); }',
    ].join('\n')

    /** The stylesheet this half owns, if it is currently in the document. */
    const styleTag = (): HTMLStyleElement | null =>
      document.querySelector('style[data-plugin="' + STYLE_ID + '"]')

    /**
     * Inject this half's stylesheet.
     *
     * The loader owns `style[data-plugin]` tags and removes them when it tears a
     * plugin down, so this is re-asserted on every pass rather than written once:
     * a stylesheet that vanished while the injected nodes stayed would leave the
     * controls unstyled instead of failing visibly.
     */
    const ensureStyles = (): void => {
      if (styleTag() !== null) return
      const el = document.createElement('style')
      el.setAttribute('data-plugin', STYLE_ID)
      el.textContent = CSS_TEXT
      document.head.appendChild(el)
    }

    /**
     * Wait for a condition the page reaches on its own React commit.
     * @param predicate - polled until it holds or the deadline passes.
     * @returns whether the predicate held before the deadline.
     */
    async function waitUntil(predicate: () => boolean): Promise<boolean> {
      const deadline = Date.now() + COMMIT_TIMEOUT_MS
      for (;;) {
        if (predicate()) return true
        if (Date.now() >= deadline) return false
        await new Promise<void>((resolve) => { setTimeout(resolve, COMMIT_POLL_MS) })
      }
    }

    /** The card an injected node belongs to, walking up to the row card. */
    function closestCard(node: Element | null): Element | undefined {
      let current: Element | null = node
      while (current !== null) {
        const candidate = current
        if (CARD_SELECTORS.some((selector) => candidate.matches(selector))) return candidate
        current = current.parentElement
      }
      return undefined
    }

    /** Reset a control to its idle look. */
    function resetControl(button: HTMLButtonElement): void {
      button.textContent = '自动获取'
      button.disabled = false
    }

    /** The bubble currently showing, and the timer that will dismiss it. */
    let bubble: HTMLDivElement | undefined
    let bubbleTimer: number | undefined

    /** Remove the result bubble, if one is up. */
    function clearBubble(): void {
      if (bubbleTimer !== undefined) {
        clearTimeout(bubbleTimer)
        bubbleTimer = undefined
      }
      bubble?.remove()
      bubble = undefined
    }

    /**
     * Show an outcome in a bubble above a control, the way the app's own
     * tooltips appear.
     *
     * The result deliberately does NOT go inline: a status line inside the
     * 输入类型 row pushed that row's own content onto a second line, which is a
     * layout change the page never asked for. A bubble is positioned out of
     * flow, so showing one cannot move anything.
     *
     * @param anchor - the control the bubble points at.
     * @param text - the outcome to show.
     * @param tone - how urgent it is, which sets how long it stays.
     */
    function showBubble(anchor: Element, text: string, tone: 'ok' | 'warn' | 'error'): void {
      clearBubble()
      const el = document.createElement('div')
      el.className = 'dma-bubble'
      el.setAttribute('role', tone === 'error' ? 'alert' : 'status')
      el.setAttribute('data-tone', tone)
      el.textContent = text
      // Appended to the body so no ancestor's clipping or stacking context can
      // hide it, matching `Tooltip`'s `portal` rendering.
      document.body.appendChild(el)
      const rect = anchor.getBoundingClientRect()
      // Above the control, right-aligned to it, then kept inside the viewport.
      const margin = 8
      const left = Math.min(
        Math.max(margin, rect.right - el.offsetWidth),
        Math.max(margin, window.innerWidth - el.offsetWidth - margin),
      )
      const top = rect.top - el.offsetHeight - 6
      el.style.left = String(Math.round(left)) + 'px'
      el.style.top = String(Math.round(top < margin ? rect.bottom + 6 : top)) + 'px'
      bubble = el
      bubbleTimer = setTimeout(clearBubble, tone === 'ok' ? BUBBLE_MS_OK : BUBBLE_MS_ATTENTION)
    }

    /**
     * Report an outcome: reset the control, then bubble the result from it.
     * @param button - the control the outcome belongs to.
     * @param text - the outcome to show.
     * @param tone - how urgent it is.
     */
    function report(button: HTMLButtonElement, text: string, tone: 'ok' | 'warn' | 'error'): void {
      resetControl(button)
      // A fill never closes the card, so the control is normally still mounted;
      // a re-render mid-request can replace it, hence the fallback anchor.
      const anchor = button.isConnected ? button : closestCard(button) ?? button
      showBubble(anchor, text, tone)
    }

    /**
     * Write into a React-controlled input by clearing React's own value tracker
     * first. Assigning `input.value` alone leaves the tracker holding the last
     * rendered value, so React discards the following change event as a no-op
     * and the draft keeps the old value.
     * @param input - the field to fill.
     * @param value - the text to put in it.
     */
    function setInputValue(input: HTMLInputElement, value: string): void {
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
      const setter = descriptor?.set
      if (setter === undefined) input.value = value
      else setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }

    /** The input inside one row whose label starts with the given text. */
    function rowInput(entry: Element, prefixes: readonly string[]): HTMLInputElement | undefined {
      for (const node of Array.from(entry.querySelectorAll('input'))) {
        const label = node.getAttribute('aria-label') ?? ''
        if (prefixes.some((prefix) => label.startsWith(prefix))) return node as HTMLInputElement
      }
      return undefined
    }

    /** Spell a count the way the page does, so a fill round-trips through it. */
    function capacityText(value: number): string {
      if (Number.isInteger(value) && value > 0) {
        if (value % 1_000_000 === 0) return String(value / 1_000_000) + 'M'
        if (value % 1_000 === 0) return String(value / 1_000) + 'K'
      }
      return String(value)
    }

    /** One model row's CURRENT id, read from the input the app labels as such. */
    function modelIdOf(entry: Element): string | undefined {
      const value = rowInput(entry, MODEL_ID_LABEL_PREFIXES)?.value.trim()
      return value === undefined || value === '' ? undefined : value
    }

    /**
     * Make sure one row's body is open, since its fields only exist then.
     * @param entry - the model row to expand.
     * @returns whether the row's body is rendered.
     */
    async function ensureRowBody(entry: Element): Promise<boolean> {
      if (entry.querySelector(ADVANCED_SELECTOR) !== null) return true
      const toggle = entry.querySelector(ROW_TOGGLE_SELECTOR)
      if (toggle !== null) (toggle as HTMLButtonElement).click()
      return waitUntil(() => entry.querySelector(ADVANCED_SELECTOR) !== null)
    }

    /**
     * Tick the row's 输入类型 checkboxes to match the catalog. A checkbox is
     * controlled too, so it is clicked rather than assigned; clicking one that
     * already matches would toggle it off.
     * @param entry - the model row to fill.
     * @param wanted - the modalities the catalog declares.
     * @returns the labels that changed.
     */
    function applyInputTypes(entry: Element, wanted: ('text' | 'image')[]): string[] {
      const boxes = Array.from(entry.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]
      if (boxes.length === 0) return []
      const changed: string[] = []
      // Enable desired types before clearing others: the host disables the last selected type.
      const order = (['text', 'image'] as const).filter((type) => wanted.includes(type))
        .concat((['text', 'image'] as const).filter((type) => !wanted.includes(type)))
      for (const modality of order) {
        const label = modality === 'text' ? '文本' : '图片'
        const labels = modality === 'text' ? ['Text', '文本'] : ['Image', '图片']
        const box = boxes.find((node) => labels.includes(node.closest('label')?.textContent?.trim() ?? ''))
        if (box === undefined || box.disabled) continue
        const want = wanted.includes(modality)
        if (box.checked === want) continue
        box.click()
        changed.push(label)
      }
      return changed
    }

    /**
     * Write the catalog values into one row's fields, through the inputs React
     * controls so the editor's draft actually changes.
     * @param entry - the model row to fill.
     * @param data - the catalog values for that row.
     * @returns the field labels that were filled, for the result line.
     */
    function applyCatalog(entry: Element, data: CatalogView): string[] {
      const filled: string[] = []
      if (data.name !== undefined) {
        const input = rowInput(entry, MODEL_NAME_LABEL_PREFIXES)
        if (input !== undefined) { setInputValue(input, data.name); filled.push('显示名称') }
      }
      if (data.contextWindow !== undefined) {
        const input = rowInput(entry, CONTEXT_WINDOW_LABEL_PREFIXES)
        if (input !== undefined) { setInputValue(input, capacityText(data.contextWindow)); filled.push('上下文窗口') }
      }
      if (data.maxTokens !== undefined) {
        const input = rowInput(entry, MAX_TOKENS_LABEL_PREFIXES)
        if (input !== undefined) { setInputValue(input, capacityText(data.maxTokens)); filled.push('最大输出') }
      }
      if (data.input !== undefined) filled.push(...applyInputTypes(entry, data.input))
      return filled
    }

    /**
     * Fill the given rows from the catalog.
     *
     * Every row's id is resolved at CALL time, so a row renamed since the
     * control was mounted is looked up under the id it currently shows. Rows
     * with no id, and rows the catalog does not know, are left exactly as they
     * are and reported rather than guessed at.
     *
     * @param entries - the rows to fill.
     * @returns how many fields each row took, and the ids the catalog did not know.
     */
    async function fillEntries(entries: Element[]): Promise<{ filled: number[]; unknown: string[] }> {
      const targets: { entry: Element; id: string }[] = []
      for (const entry of entries) {
        const id = modelIdOf(entry)
        // A row the user has not named yet cannot be looked up; expanding it to
        // find that out would be a pointless layout change.
        if (id !== undefined) targets.push({ entry, id })
      }
      // One request for however many rows were asked for, so a whole-card fill
      // does not put a request per model on the critical path.
      const unique = [...new Set(targets.map((target) => target.id))]
      let payload: CatalogBatchResponse = {}
      if (unique.length > 0) {
        const response = await fetch(API + '/catalog?ids=' + encodeURIComponent(unique.join(',')))
        payload = await response.json() as CatalogBatchResponse
        if (payload.ok !== true) return { filled: [], unknown: [] }
      }
      const models = payload.models ?? {}
      const filled: number[] = []
      for (const { entry, id } of targets) {
        const data = models[id]
        if (data === undefined) continue
        if (!await ensureRowBody(entry)) continue
        filled.push(applyCatalog(entry, data).length)
      }
      // `unknown` covers only the ids this call actually asked about, so a blank
      // row is never counted as a catalog gap.
      const asked = new Set(unique)
      const unknown = (payload.unknown ?? []).filter((id) => asked.has(id))
      return { filled, unknown }
    }

    /** The result text for a multi-row fill. */
    const wholeCardText = (filled: number[], unknown: string[]): { text: string; tone: 'ok' | 'warn' } => {
      const applied = filled.filter((count) => count > 0).length
      const gap = unknown.length > 0 ? '，' + String(unknown.length) + ' 个目录未收录' : ''
      if (applied === 0) {
        // Nothing was written: say why, naming the gap only when there is one.
        return {
          text: unknown.length > 0 ? '目录未收录这些模型' + gap : '目录没有可填的字段',
          tone: 'warn',
        }
      }
      return {
        text: '已填入 ' + String(applied) + ' 行，点「保存」写入' + gap,
        tone: unknown.length > 0 ? 'warn' : 'ok',
      }
    }

    /**
     * Fill every model row of one card from the catalog.
     * @param button - the pressed control, disabled while the request runs.
     * @param card - the card whose rows to fill.
     */
    async function fillCard(button: HTMLButtonElement, card: Element): Promise<void> {
      clearBubble()
      button.disabled = true
      button.textContent = '获取中…'
      try {
        const entries = Array.from(card.querySelectorAll(ENTRY_SELECTOR))
        if (entries.length === 0) {
          report(button, '这张卡片没有模型行', 'warn')
          return
        }
        const { filled, unknown } = await fillEntries(entries)
        const outcome = wholeCardText(filled, unknown)
        report(button, outcome.text, outcome.tone)
      } catch (error) {
        report(button, '请求失败：' + String(error), 'error')
      }
    }

    /**
     * Fill one model row from the catalog.
     * @param button - the pressed control, disabled while the request runs.
     * @param resolveModelId - called at click time so an edited id is honored.
     */
    async function fillRow(button: HTMLButtonElement, resolveModelId: () => string | undefined): Promise<void> {
      const modelId = resolveModelId()
      // A row control never widens to the whole card: an unfilled id is a
      // refusal, not a broader fill.
      if (modelId === undefined || modelId === '') {
        report(button, '请先填写模型 ID', 'warn')
        return
      }
      clearBubble()
      button.disabled = true
      button.textContent = '获取中…'
      try {
        const card = closestCard(button)
        const entry = card === undefined ? undefined : rowForId(card, modelId)
        if (card === undefined || entry === undefined) {
          report(button, '找不到该模型行，请重新展开', 'warn')
          return
        }
        const response = await fetch(API + '/catalog?ids=' + encodeURIComponent(modelId))
        const payload = await response.json() as CatalogBatchResponse
        if (payload.ok !== true) {
          report(button, '获取失败', 'warn')
          return
        }
        const data = (payload.models ?? {})[modelId]
        if (data === undefined) {
          report(button, '目录未收录该模型', 'warn')
          return
        }
        if (!await ensureRowBody(entry)) {
          report(button, '找不到该模型行，请重新展开', 'warn')
          return
        }
        const filled = applyCatalog(entry, data)
        if (filled.length === 0) {
          report(button, '目录没有可填的字段', 'warn')
          return
        }
        report(button, '已填入 ' + filled.join(' / ') + '，点「保存」写入', 'ok')
      } catch (error) {
        report(button, '请求失败：' + String(error), 'error')
      }
    }

    /** The row element whose model-id input currently holds the given id. */
    function rowForId(card: Element, modelId: string): Element | undefined {
      for (const entry of Array.from(card.querySelectorAll(ENTRY_SELECTOR))) {
        if (modelIdOf(entry) === modelId) return entry
      }
      return undefined
    }

    /**
     * Build one control: the button plus the holder its result line goes in.
     * @param provider - the route it belongs to.
     * @param variant - which line the control joins, for placement styling.
     * @param resolveModelId - present for a row control; resolved at click time.
     */
    function buildControl(
      provider: string,
      variant: 'row' | 'head',
      resolveModelId?: () => string | undefined,
    ): HTMLDivElement {
      const wrapper = document.createElement('div')
      wrapper.className = variant === 'row' ? 'dma-sync dma-sync--row ' + MARK : 'dma-sync ' + MARK
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'dma-syncButton'
      button.textContent = '自动获取'
      button.title = variant === 'row'
        ? '从 models.dev 目录获取并填入本行字段，由卡片「保存」写入（不影响其它行）'
        : '从 models.dev 目录获取并填入本卡片所有模型行，由卡片「保存」写入（不影响其它未保存的修改）'
      button.addEventListener('click', () => {
        if (resolveModelId === undefined) {
          const card = closestCard(button)
          if (card === undefined) { report(button, '找不到所属卡片', 'warn'); return }
          void fillCard(button, card)
          return
        }
        void fillRow(button, resolveModelId)
      })
      wrapper.appendChild(button)
      return wrapper
    }

    /** The saved row or first-run editor's title, used to find its route id. */
    function cardName(card: Element): string | undefined {
      const node = card.querySelector(HEAD_SELECTOR)?.querySelector(NAME_SELECTOR) ?? card.querySelector(NAME_SELECTOR)
      const text = (node ?? card.querySelector(EDITOR_TITLE_SELECTOR))?.textContent?.trim()
      return text === undefined || text === '' ? undefined : text
    }

    /**
     * The host's provider list, refreshed by the mount pass. It lives at factory
     * scope because a provider list arriving after a pass has to be able to
     * request another one.
     */
    let byDisplayName = new Map<string, string>()
    let byProvider = new Map<string, string>()
    let loadingProviders: Promise<void> | undefined
    /** Scheduled by the mount pass; a provider-list arrival may request one. */
    let schedulePass: () => void = () => { /* replaced by mount */ }

    /** Read the host's provider list and replace the cached route maps. */
    const loadProviders = (): Promise<void> => {
      if (loadingProviders !== undefined) return loadingProviders
      // A pass that started before these maps existed (the very first one, or the
      // first after a navigation) has no route ids to mount with, so the arrival
      // of the list must schedule the pass that uses it.
      const attempt = fetch(API + '/providers')
        .then((response) => response.json() as Promise<{ providers?: ProviderIdentityView[] }>)
        .then((data) => {
          const nextDisplay = new Map<string, string>()
          const nextProvider = new Map<string, string>()
          for (const entry of data.providers ?? []) {
            if (typeof entry?.provider !== 'string' || entry.provider === '') continue
            nextProvider.set(entry.provider, entry.provider)
            if (typeof entry.displayName === 'string' && entry.displayName !== '') {
              nextDisplay.set(entry.displayName, entry.provider)
            }
          }
          // A newly saved or renamed provider can arrive after the DOM pass
          // that requested it. Re-run on map changes, even with a warm cache.
          const changed = nextDisplay.size !== byDisplayName.size || nextProvider.size !== byProvider.size
            || [...nextDisplay].some(([name, id]) => byDisplayName.get(name) !== id)
            || [...nextProvider].some(([id]) => !byProvider.has(id))
          byDisplayName = nextDisplay
          byProvider = nextProvider
          if (changed) schedulePass()
        })
        .catch(() => { /* keep the last map; the next pass retries */ })
        .finally(() => { if (loadingProviders === attempt) loadingProviders = undefined })
      loadingProviders = attempt
      return attempt
    }

    /**
     * Mount both controls, following the page as it opens, closes, and
     * re-renders.
     * @returns the teardown that stops observation and removes every added node.
     */
    function mount(): () => void {
      let stopped = false
      let passScheduled = false

      /** Run one more pass after the current work settles, coalescing bursts. */
      schedulePass = (): void => {
        if (passScheduled || stopped) return
        passScheduled = true
        queueMicrotask(() => {
          passScheduled = false
          pass()
        })
      }

      /** Resolve a card's shown title to the route id it belongs to. */
      const routeOf = (card: Element): string | undefined => {
        const route = card.querySelector(EDITOR_ROUTE_SELECTOR)?.textContent?.trim()
        if (route !== undefined && byProvider.has(route)) return route
        const name = cardName(card)
        if (name === undefined) return undefined
        // A provider whose title is its own id appears in both maps; prefer the
        // id map so a title colliding with another route's display name cannot
        // address the wrong card.
        return byProvider.get(name) ?? byDisplayName.get(name)
      }

      /** The control already anchored at this line, if any. */
      const hasControl = (anchor: Element): boolean => anchor.querySelector('.' + MARK) !== null

      const pass = (): void => {
        if (stopped) return
        ensureStyles()
        void loadProviders()
        // Drop controls whose anchor has left the page (the section re-renders
        // cards, and the editor is swapped as rows open and close).
        for (const stale of Array.from(document.querySelectorAll('.' + MARK))) {
          if (!stale.isConnected) stale.remove()
        }
        for (const card of CARD_SELECTORS.flatMap((selector) => Array.from(document.querySelectorAll(selector)))) {
          const provider = routeOf(card)
          // Without a route id the card is not one this plugin addresses, which
          // also keeps the controls off routes that only exist in the
          // composition base.
          if (provider === undefined) continue

          // Provider control: the 模型目录 heading, placed just before the
          // 获取可用模型 button so it sits with the line's other actions.
          const head = card.querySelector(LIST_HEAD_SELECTOR)
          if (head !== null && !hasControl(head)) {
            const control = buildControl(provider, 'head')
            const actions = Array.from(head.querySelectorAll('button'))
            const last = actions[actions.length - 1]
            if (last === undefined) head.appendChild(control)
            else last.before(control)
          }

          // Per-model controls: the right end of each open row's 输入类型 line.
          // A collapsed row has no such line, so it has no control until the
          // user expands it. The id is resolved when the button is pressed, so a
          // row whose id changes afterwards is still looked up correctly.
          for (const entry of Array.from(card.querySelectorAll(ENTRY_SELECTOR))) {
            const choices = entry.querySelector(ADVANCED_SELECTOR)?.querySelector(INPUT_CHOICES_SELECTOR)
            if (choices == null || hasControl(choices)) continue
            choices.appendChild(buildControl(provider, 'row', () => modelIdOf(entry)))
          }
        }
      }

      const observer = new MutationObserver(() => { pass() })
      observer.observe(document.body, { childList: true, subtree: true })
      // `head` too: the loader removes `style[data-plugin]` tags when it tears a
      // plugin down, so a stylesheet that vanished while these nodes stayed must
      // be noticed and re-added rather than leaving the controls unstyled.
      observer.observe(document.head, { childList: true, subtree: true })
      pass()
      return () => {
        stopped = true
        observer.disconnect()
        clearBubble()
        for (const node of document.querySelectorAll('.' + MARK)) node.remove()
      }
    }

    return {
      name: 'model-meta-autofill',
      inject: [],
      apply(ctx: { effect: (fn: () => () => void, label?: string) => void }) {
        // One effect owns the observer and every node this half adds, so the
        // loader's disposal (unload, reload, HMR) removes them again.
        ctx.effect(() => mount(), 'dsh-model-meta-autofill: fill buttons')
      },
    }
  },
})
