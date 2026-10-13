import { AiAnswerError, buildAiJob, parseAiAnswer, SYSTEM_PROMPT, type AiInput, type AiJob } from './ai.js'
import type { AiSuggestion } from './plan.js'

/**
 * The two AI engines. Both only answer a job built by buildAiJob; the extension checks every answer.
 *   - On-device: Chrome's built-in model (Gemini Nano) through the Prompt API. Nothing leaves the computer.
 *   - OpenRouter: free models only (ids ending in ":free"), with the user's own key. Off unless chosen.
 */

export interface AiEngine {
  readonly name: string
  /** Characters of clip the engine can take in one prompt (a rough budget; the job is cut to fit). */
  readonly maxChars: number
  run(job: AiJob, signal?: AbortSignal): Promise<string>
}

export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiUnavailableError'
  }
}

/**
 * Builds the job, runs it, and checks the answer. A malformed answer is retried once; a prompt too
 * big for the model is retried once with half the content.
 */
export async function suggest(
  engine: AiEngine,
  input: AiInput,
  signal?: AbortSignal,
): Promise<{ suggestions: Map<string, AiSuggestion>; truncated: boolean; job?: AiJob }> {
  let maxChars = engine.maxChars
  let malformed = 0
  for (;;) {
    const job = buildAiJob(input, { maxChars })
    if (!job) return { suggestions: new Map(), truncated: false }
    try {
      const raw = await engine.run(job, signal)
      return { suggestions: parseAiAnswer(job, raw), truncated: job.truncated, job }
    } catch (error) {
      if (error instanceof AiAnswerError && malformed++ === 0) continue
      if (isQuotaError(error) && maxChars > 2000) {
        maxChars = Math.floor(maxChars / 2)
        continue
      }
      throw error
    }
  }
}

function isQuotaError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'QuotaExceededError' || /quota|too large|context/i.test(error.message))
}

// ------------------------------------------------------------------------------- on-device

/** The parts of Chrome's Prompt API used here (Chrome 138+, extension pages; not in workers). */
interface LanguageModelSession {
  prompt(input: string, options?: { responseConstraint?: unknown; signal?: AbortSignal }): Promise<string>
  destroy(): void
  contextWindow?: number
  contextUsage?: number
  inputQuota?: number
  inputUsage?: number
}
interface LanguageModelStatic {
  availability(options?: unknown): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>
  create(options?: unknown): Promise<LanguageModelSession>
  params?(): Promise<{ defaultTopK: number; maxTopK: number; defaultTemperature: number; maxTemperature: number }>
}

function languageModel(): LanguageModelStatic | undefined {
  return (globalThis as { LanguageModel?: LanguageModelStatic }).LanguageModel
}

const LANGUAGES = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] }

export type OnDeviceStatus = 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available'

export async function onDeviceStatus(): Promise<OnDeviceStatus> {
  const api = languageModel()
  if (!api) return 'unsupported'
  try {
    return await api.availability(LANGUAGES)
  } catch {
    return 'unavailable'
  }
}

export const ON_DEVICE_HELP: Record<OnDeviceStatus, string> = {
  unsupported: 'This version of Chrome has no built-in AI. It needs Chrome 138 or later on Windows 10/11, macOS 13+, Linux or a Chromebook Plus.',
  unavailable: 'Chrome says the built-in model can’t run here. Open chrome://on-device-internals to see why (usually disk space: it needs 22 GB free, or a graphics card with more than 4 GB, or 16 GB of RAM).',
  downloadable: 'Ready to download. Chrome downloads the model once (a few GB) over an unmetered connection.',
  downloading: 'Chrome is downloading the model.',
  available: 'Ready. It runs on this computer and sends nothing anywhere.',
}

/**
 * Chrome's built-in model. One session is kept while the panel is open (creating one takes time),
 * and it is made with a low temperature so answers are consistent from one clip to the next.
 */
export class OnDeviceEngine implements AiEngine {
  readonly name = 'On-device AI'
  maxChars = 6000
  private session: Promise<LanguageModelSession> | undefined

  /** Creates the session; the first call downloads the model, so it must follow a click. */
  async prepare(onProgress?: (fraction: number) => void): Promise<void> {
    await this.getSession(onProgress)
  }

  private getSession(onProgress?: (fraction: number) => void): Promise<LanguageModelSession> {
    const api = languageModel()
    if (!api) return Promise.reject(new AiUnavailableError(ON_DEVICE_HELP.unsupported))
    this.session ??= (async () => {
      const options: Record<string, unknown> = {
        ...LANGUAGES,
        initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
        monitor(m: EventTarget) {
          m.addEventListener('downloadprogress', (e) => onProgress?.((e as Event & { loaded: number }).loaded))
        },
      }
      // Extensions may set both temperature and topK (or neither).
      try {
        const params = await api.params?.()
        if (params) Object.assign(options, { temperature: Math.min(0.2, params.maxTemperature), topK: Math.min(3, params.maxTopK) })
      } catch {
        // Defaults are fine.
      }
      let session: LanguageModelSession
      try {
        session = await api.create(options)
      } catch (error) {
        if (!('temperature' in options)) throw error
        delete options.temperature
        delete options.topK
        session = await api.create(options)
      }
      const window = session.contextWindow ?? session.inputQuota
      // About four characters a token, leaving room for the fields and the answer.
      if (window) this.maxChars = Math.max(2000, Math.floor(window * 4 * 0.6))
      return session
    })()
    this.session.catch(() => (this.session = undefined))
    return this.session
  }

  async run(job: AiJob, signal?: AbortSignal): Promise<string> {
    const status = await onDeviceStatus()
    if (status !== 'available') throw new AiUnavailableError(ON_DEVICE_HELP[status])
    const session = await this.getSession()
    // The system prompt is in the session already.
    return session.prompt(job.prompt, { responseConstraint: job.schema, signal })
  }

  destroy(): void {
    void this.session?.then((s) => s.destroy()).catch(() => {})
    this.session = undefined
  }
}

// ------------------------------------------------------------------------------- OpenRouter

export const OPENROUTER_ORIGIN = 'https://openrouter.ai'

export interface FreeModel {
  id: string
  name: string
  contextLength: number
  /** Supports a JSON schema for the answer. */
  structured: boolean
  jsonMode: boolean
}

/** Free text models, those that can answer in a JSON schema first. */
export async function listFreeModels(fetchImpl: typeof fetch = fetch): Promise<FreeModel[]> {
  const response = await fetchImpl(`${OPENROUTER_ORIGIN}/api/v1/models`)
  if (!response.ok) throw new Error(`OpenRouter's model list answered ${response.status}.`)
  const { data } = (await response.json()) as { data: { id: string; name?: string; context_length?: number; supported_parameters?: string[]; architecture?: { output_modalities?: string[] } }[] }
  return data
    .filter((m) => m.id.endsWith(':free') && (m.architecture?.output_modalities ?? ['text']).includes('text') && !/safety|guard/i.test(m.id))
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      contextLength: m.context_length ?? 0,
      structured: (m.supported_parameters ?? []).includes('structured_outputs'),
      jsonMode: (m.supported_parameters ?? []).includes('response_format'),
    }))
    .sort((a, b) => Number(b.structured) - Number(a.structured) || Number(b.jsonMode) - Number(a.jsonMode) || a.name.localeCompare(b.name))
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'OpenRouterError'
  }
}

/**
 * OpenRouter with free models only. Limits on the free tier: 20 requests a minute, and 50 a day
 * (1,000 after $10 of credit). Failed requests can count towards the daily limit, so a busy or
 * missing model is retried once with the next free model and never looped.
 */
export class OpenRouterEngine implements AiEngine {
  readonly name = 'OpenRouter'
  readonly maxChars = 24_000

  constructor(
    private readonly options: { apiKey: string; model: string; fallbacks?: FreeModel[]; fetchImpl?: typeof fetch },
  ) {
    if (!options.model.endsWith(':free')) throw new AiUnavailableError('Only free OpenRouter models (ids ending in ":free") are used.')
  }

  async run(job: AiJob, signal?: AbortSignal): Promise<string> {
    const fallback = this.options.fallbacks?.find((m) => m.id !== this.options.model)
    try {
      return await this.call(this.options.model, job, this.options.fallbacks?.find((m) => m.id === this.options.model), signal)
    } catch (error) {
      if (!(error instanceof OpenRouterError) || [401, 402, 429].includes(error.status) || !fallback) throw error
      return this.call(fallback.id, job, fallback, signal)
    }
  }

  private async call(model: string, job: AiJob, info: FreeModel | undefined, signal?: AbortSignal): Promise<string> {
    const body: Record<string, unknown> = {
      model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: job.system },
        { role: 'user', content: job.prompt },
      ],
    }
    if (info?.structured) body.response_format = { type: 'json_schema', json_schema: { name: 'template_fill', strict: true, schema: job.schema } }
    else if (info?.jsonMode) body.response_format = { type: 'json_object' }
    const response = await (this.options.fetchImpl ?? fetch)(`${OPENROUTER_ORIGIN}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.apiKey}`, 'X-Title': 'LK Web Clipper' },
      body: JSON.stringify(body),
      signal,
    })
    const text = await response.text()
    if (!response.ok) throw new OpenRouterError(openRouterMessage(response.status, text, response.headers.get('retry-after')), response.status)
    const data = JSON.parse(text) as { choices?: { message?: { content?: string } }[]; error?: { message?: string; code?: number } }
    if (data.error) throw new OpenRouterError(`OpenRouter: ${data.error.message ?? 'the model failed'}.`, data.error.code ?? 502)
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new OpenRouterError('OpenRouter returned an empty answer.', 502)
    return content
  }
}

function openRouterMessage(status: number, body: string, retryAfter: string | null): string {
  let detail = ''
  try {
    detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? ''
  } catch {
    detail = body.slice(0, 200)
  }
  if (status === 401) return 'OpenRouter rejected the key. Check it in Settings.'
  if (status === 402) return 'OpenRouter says the account has no credit for this request. Free models need none, but the daily free limit may be used up.'
  if (status === 429) return `OpenRouter's free limit was reached${retryAfter ? `; try again in ${retryAfter} seconds` : ' (20 a minute, 50 a day without credit)'}. Label results are used for now.`
  if (status === 404) return 'That free model is no longer on OpenRouter. Pick another in Settings.'
  return `OpenRouter answered ${status}${detail ? `: ${detail}` : ''}.`
}

export { buildAiJob }
