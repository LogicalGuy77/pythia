// State machine for a single Pythia inference run. The dashboard merges live
// SSE events into this shape so the UI can render an event timeline plus a
// per-peer card view side by side.

import type {
  ConsensusEvent,
  PersistedRunEvent,
  PeerOutputEvent,
  PeerStartedEvent,
  PeerVerifiedEvent,
  ResearchEvent,
  RunEvent,
  TradeDecisionEvent,
  TradeResultEvent,
} from './types'

export type TimelineKind = 'status' | 'success' | 'warning' | 'danger' | 'brand'

export interface TimelineEntry {
  ts: number
  kind: TimelineKind
  title: string
  detail?: string
}

export interface PeerRunState {
  peerId: string
  shortId: string
  address?: string
  output?: string
  receipt?: unknown
  receiptHash?: string | null
  verified?: boolean
  verifyMessage?: string
  status: 'pending' | 'running' | 'received' | 'verifying' | 'verified' | 'failed' | 'error'
  error?: string
}

export interface RunState {
  running: boolean
  timeline: TimelineEntry[]
  peers: Record<string, PeerRunState>
  peerOrder: string[]
  research: ResearchEvent | null
  consensus: ConsensusEvent | null
  tradeDecision: TradeDecisionEvent | null
  tradeResult: TradeResultEvent | null
  fatalError: string | null
  done: boolean
}

export const initialRunState: RunState = {
  running: false,
  timeline: [],
  peers: {},
  peerOrder: [],
  research: null,
  consensus: null,
  tradeDecision: null,
  tradeResult: null,
  fatalError: null,
  done: false,
}

export type RunAction =
  | { type: 'reset' }
  | { type: 'start' }
  | { type: 'event'; ev: RunEvent; ts: number }
  | { type: 'loadHistory'; events: PersistedRunEvent[] }
  | { type: 'cancel' }
  | { type: 'finish' }

function pushTimeline(s: RunState, e: TimelineEntry): RunState {
  return { ...s, timeline: [...s.timeline, e] }
}

function ensurePeer(s: RunState, peerId: string, init: Partial<PeerRunState> = {}): RunState {
  if (s.peers[peerId]) return s
  const peer: PeerRunState = {
    peerId,
    shortId: init.shortId ?? peerId.slice(0, 8),
    address: init.address,
    status: 'pending',
    ...init,
  }
  return {
    ...s,
    peers: { ...s.peers, [peerId]: peer },
    peerOrder: [...s.peerOrder, peerId],
  }
}

function patchPeer(
  s: RunState,
  peerId: string,
  patch: Partial<PeerRunState>,
): RunState {
  const existing = s.peers[peerId]
  if (!existing) return s
  return {
    ...s,
    peers: { ...s.peers, [peerId]: { ...existing, ...patch } },
  }
}

export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'reset':
      return initialRunState
    case 'start':
      return { ...initialRunState, running: true }
    case 'cancel':
      return pushTimeline(
        { ...state, running: false, done: true },
        {
          ts: Date.now() / 1000,
          kind: 'warning',
          title: 'Run cancelled',
        },
      )
    case 'finish':
      return { ...state, running: false, done: true }
    case 'loadHistory': {
      let replayed: RunState = initialRunState
      for (const ev of action.events) {
        replayed = applyEvent(
          replayed,
          { event: ev.event, data: ev.data } as RunEvent,
          ev.ts,
        )
      }
      return { ...replayed, running: false, done: true }
    }
    case 'event':
      return applyEvent(state, action.ev, action.ts)
  }
}

function applyEvent(state: RunState, ev: RunEvent, ts: number): RunState {
  switch (ev.event) {
    case 'status': {
      const phase = ev.data.phase
      const labels: Record<string, string> = {
        discover:  'Discovering peers',
        research:  'Researching current context',
        inference: 'Fanning prompt to peers',
        verify:    'Verifying receipt',
        aggregate: 'Aggregating consensus',
        trade:     'Submitting trade',
      }
      return pushTimeline(state, {
        ts,
        kind: phase === 'trade' ? 'brand' : 'status',
        title: labels[phase] ?? phase,
        detail: ev.data.message,
      })
    }

    case 'topology': {
      let s = state
      for (const p of ev.data.peers) {
        s = ensurePeer(s, p.publicKey, {
          shortId: p.publicKey.slice(0, 10) + '…' + p.publicKey.slice(-6),
          address: p.address,
        })
      }
      return pushTimeline(s, {
        ts,
        kind: 'success',
        title: `Discovered ${ev.data.peerCount} peer${ev.data.peerCount === 1 ? '' : 's'}`,
        detail: ev.data.peers.map((p) => p.publicKey.slice(0, 14) + '…').join('  ·  '),
      })
    }

    case 'research': {
      const data = ev.data as ResearchEvent
      return pushTimeline(
        { ...state, research: data },
        {
          ts,
          kind: data.ok ? 'brand' : 'warning',
          title: data.ok
            ? `Exa returned ${data.results.length} source${data.results.length === 1 ? '' : 's'}`
            : 'Exa research unavailable',
          detail: data.ok ? data.query : data.error,
        },
      )
    }

    case 'peer_started': {
      const e = ev.data as PeerStartedEvent
      let s = ensurePeer(state, e.peerId, {
        shortId: e.shortId,
        address: e.address,
      })
      s = patchPeer(s, e.peerId, { status: 'running' })
      return pushTimeline(s, {
        ts,
        kind: 'status',
        title: `Calling peer ${e.shortId}`,
        detail: e.address,
      })
    }

    case 'peer_output': {
      const e = ev.data as PeerOutputEvent
      let s = ensurePeer(state, e.peerId, { shortId: e.shortId })
      if (e.error) {
        s = patchPeer(s, e.peerId, {
          status: 'error',
          error: e.error,
        })
        return pushTimeline(s, {
          ts,
          kind: 'danger',
          title: `Peer ${e.shortId} unreachable`,
          detail: e.error,
        })
      }
      s = patchPeer(s, e.peerId, {
        status: 'received',
        output: e.output,
        receipt: e.receipt,
        receiptHash: e.receiptHash,
      })
      const trimmed = (e.output ?? '').replace(/\s+/g, ' ').trim().slice(0, 140)
      return pushTimeline(s, {
        ts,
        kind: 'success',
        title: `Peer ${e.shortId} returned receipt`,
        detail: trimmed || '(empty output)',
      })
    }

    case 'peer_verified': {
      const e = ev.data as PeerVerifiedEvent
      const status: PeerRunState['status'] = e.verified ? 'verified' : 'failed'
      const s = patchPeer(state, e.peerId, {
        status,
        verified: e.verified,
        verifyMessage: e.message,
      })
      return pushTimeline(s, {
        ts,
        kind: e.verified ? 'success' : 'danger',
        title: e.verified
          ? `Peer ${e.shortId} verified`
          : `Peer ${e.shortId} failed verification`,
        detail: e.message,
      })
    }

    case 'consensus': {
      const data = ev.data as ConsensusEvent
      return pushTimeline(
        { ...state, consensus: data },
        {
          ts,
          kind: 'brand',
          title:
            data.consensusProbability === null
              ? 'No probability extracted'
              : `Consensus ${(data.consensusProbability * 100).toFixed(1)}%`,
          detail: `${data.verifiedCount} of ${data.totalCount} peers verified`,
        },
      )
    }

    case 'trade_decision': {
      const data = ev.data as TradeDecisionEvent
      const map: Record<TradeDecisionEvent['decision'], TimelineKind> = {
        trade: 'brand',
        abstain: 'warning',
        abort: 'danger',
        skipped: 'status',
      }
      const titleMap: Record<TradeDecisionEvent['decision'], string> = {
        trade:   `Decision: ${data.outcomeLabel ?? '?'} (${data.amountUsdc} USDC)`,
        abstain: 'Decision: abstain (uncertainty band)',
        abort:   'Decision: abort',
        skipped: 'No market — skipping trade',
      }
      return pushTimeline(
        { ...state, tradeDecision: data },
        {
          ts,
          kind: map[data.decision],
          title: titleMap[data.decision],
          detail: data.rationale ?? data.reason,
        },
      )
    }

    case 'trade_result': {
      const data = ev.data as TradeResultEvent
      return pushTimeline(
        { ...state, tradeResult: data },
        {
          ts,
          kind: data.ok ? 'success' : 'danger',
          title: data.ok ? 'Trade settled on-chain' : 'Trade failed',
          detail: data.ok ? data.transactionHash : data.error,
        },
      )
    }

    case 'done':
      return pushTimeline(
        { ...state, running: false, done: true },
        {
          ts,
          kind: ev.data.ok ? 'success' : 'warning',
          title: ev.data.ok ? 'Run complete' : 'Run finished with errors',
        },
      )

    case 'error':
      return pushTimeline(
        { ...state, fatalError: ev.data.message, running: false, done: true },
        {
          ts,
          kind: 'danger',
          title: 'Pipeline error',
          detail: ev.data.message,
        },
      )
  }
}
