// Shape-resilient helpers for rendering Delphi markets in the UI.
// The SDK occasionally adds/removes fields, so we always probe several paths.

import type { Market } from './types'

export function marketTitle(m: Market): string {
  return (
    m.metadata?.question ??
    (m.question as string | undefined) ??
    (m.title as string | undefined) ??
    m.id
  )
}

export function marketOutcomes(m: Market): string[] {
  if (m.metadata?.outcomes && Array.isArray(m.metadata.outcomes)) {
    return m.metadata.outcomes
  }
  if (Array.isArray(m.outcomeNames)) {
    return m.outcomeNames.filter((outcome): outcome is string => typeof outcome === 'string')
  }
  return ['YES', 'NO']
}

export function marketSettlesAt(m: Market): string | null {
  return m.settlesAt ?? m.resolvesAt ?? null
}

export function fmtSettles(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = Date.now()
  const ms  = d.getTime() - now
  const days = Math.round(ms / 86_400_000)
  if (ms < 0)            return `settled ${d.toLocaleDateString()}`
  if (days === 0)        return 'settles today'
  if (days === 1)        return 'settles in 1 day'
  if (days < 30)         return `settles in ${days} days`
  return `settles ${d.toLocaleDateString()}`
}
