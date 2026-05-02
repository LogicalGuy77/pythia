// Lightweight client wrappers around the Pythia dashboard api_server.
// Past runs are loaded from static exports so the Vercel demo can be read-only.

import type {
  Health,
  MarketsResponse,
  PersistedRun,
  RunEvent,
  RunsResponse,
  Topology,
  Wallet,
} from './types'

async function jget<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`GET ${path} -> ${res.status}: ${txt.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

export const api = {
  health:    () => jget<Health>('/api/health'),
  topology:  () => jget<Topology>('/api/topology'),
  markets:   () => jget<MarketsResponse>('/api/markets'),
  wallet:    () => jget<Wallet>('/api/wallet'),
  runs:      (limit = 25) => {
    void limit
    return jget<RunsResponse>('/data/runs.json')
  },
  run:       (runId: string) => jget<PersistedRun>(`/data/runs/${runId}.json`),
  deleteRun: async (runId: string) => {
    void runId
    throw new Error('Deleting runs is disabled in the read-only demo')
  },
}

// ---------------------------------------------------------------------
// SSE run client
// ---------------------------------------------------------------------
//
// EventSource only supports GET, so we hand-parse a fetch() body to consume
// SSE from a POST endpoint. AbortController lets the UI cancel a run.

export interface RunRequest {
  prompt: string
  market_id?: string | null
  amount_usdc?: number
  min_verified_peers?: number
  verify?: boolean
  outcome_index?: 0 | 1 | null
}

export async function startRun(
  req: RunRequest,
  onEvent: (ev: RunEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  })

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => '')
    throw new Error(`run failed (${res.status}): ${txt.slice(0, 200)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // SSE frames are separated by a blank line
    let idx
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)

      let event = 'message'
      const dataLines: string[] = []
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }
      if (dataLines.length === 0) continue

      try {
        const data = JSON.parse(dataLines.join('\n'))
        onEvent({ event, data } as RunEvent)
      } catch {
        // ignore malformed frames
      }
    }
  }
}
