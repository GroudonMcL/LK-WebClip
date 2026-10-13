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

/** Connects every key and names its project, so the UI can skip the project picker when there is one. */
export async function connectProjects(keys: string[]): Promise<ProjectConnection[]> {
  return Promise.all(
    keys.map(async (apiKey) => {
      const lk = new LegendKeeper({ apiKey, maxRetries: 3 })
      const project = await lk.project()
      return { id: project.id, name: project.name ?? project.id, lk }
    }),
  )
}
