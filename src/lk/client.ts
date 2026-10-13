import { LegendKeeper } from '@legendkeeper/sdk'

export interface ProjectConnection {
  id: string
  name: string
  lk: LegendKeeper
}

/**
 * Reads every configured key. LEGENDKEEPER_API_KEYS takes a comma-separated list (one key per
 * project, since a key only reaches its own project); LEGENDKEEPER_API_KEY is the single-key form.
 */
export function configuredKeys(env: Record<string, string | undefined>): string[] {
  const keys = [env.LEGENDKEEPER_API_KEYS ?? '', env.LEGENDKEEPER_API_KEY ?? '']
    .flatMap((value) => value.split(','))
    .map((key) => key.trim())
    .filter((key) => key.length > 0)
  return [...new Set(keys)]
}

/**
 * A client for one API key. The fetch wrapper matters in browsers: the SDK calls the function it
 * stores without `window` as its receiver, which Chrome rejects with "Illegal invocation".
 */
export function createClient(apiKey: string, { maxRetries = 3 }: { maxRetries?: number } = {}): LegendKeeper {
  return new LegendKeeper({ apiKey, maxRetries, fetch: (url, init) => globalThis.fetch(url, init) })
}

/** Connects every key and names its project, so the UI can skip the project picker when there is one. */
export async function connectProjects(keys: string[]): Promise<ProjectConnection[]> {
  return Promise.all(
    keys.map(async (apiKey) => {
      const lk = createClient(apiKey)
      const project = await lk.project()
      return { id: project.id, name: project.name ?? project.id, lk }
    }),
  )
}
