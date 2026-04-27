import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import './App.css'

import { api, startRun } from './api'
import type { Health, Market, RunEvent, RunSummary, Topology, Wallet } from './types'
import { initialRunState, runReducer } from './runState'

import { Topbar } from './components/Topbar'
import { Sidebar } from './components/Sidebar'
import { RunPanel } from './components/RunPanel'
import { PeerCard } from './components/PeerCard'
import { Consensus } from './components/Consensus'
import { Trade } from './components/Trade'
import { PastRuns } from './components/PastRuns'

const DEFAULT_PROMPT =
  'Will ETH be above $3000 at the end of 2025? Give a numeric probability percentage.'

function App() {
  // ── Server state polled on mount and periodically ──────────────────────
  const [health, setHealth] = useState<Health | null>(null)
  const [topology, setTopology] = useState<Topology | null>(null)
  const [topologyError, setTopologyError] = useState<string | null>(null)
  const [wallet, setWallet] = useState<Wallet | null>(null)
  const [walletError, setWalletError] = useState<string | null>(null)
  const [markets, setMarkets] = useState<Market[]>([])
  const [marketsLoading, setMarketsLoading] = useState(false)
  const [marketsError, setMarketsError] = useState<string | null>(null)
  const [selectedMarket, setSelectedMarket] = useState<Market | null>(null)
  const [pastRuns, setPastRuns] = useState<RunSummary[]>([])
  const [pastRunsLoading, setPastRunsLoading] = useState(false)
  const [pastRunsError, setPastRunsError] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)

  // ── Run config + state ──────────────────────────────────────────────────
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [amount, setAmount] = useState(0.05)
  const [minVerified, setMinVerified] = useState(2)
  const [verify, setVerify] = useState(true)
  const [runState, dispatch] = useReducer(runReducer, initialRunState)
  const abortRef = useRef<AbortController | null>(null)

  // ── Initial fetch + 8s polling for live status panels ──────────────────
  useEffect(() => {
    let cancelled = false

    const tick = async () => {
      try {
        const h = await api.health()
        if (!cancelled) setHealth(h)
      } catch {
        if (!cancelled) setHealth({ ok: false, services: {} })
      }
      try {
        const t = await api.topology()
        if (!cancelled) {
          setTopology(t)
          setTopologyError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setTopology({ ourPublicKey: null, peerCount: 0, peers: [] })
          setTopologyError((err as Error).message)
        }
      }
      try {
        const w = await api.wallet()
        if (!cancelled) {
          setWallet(w)
          setWalletError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setWallet(null)
          setWalletError((err as Error).message.slice(0, 220))
        }
      }
    }

    tick()
    const id = window.setInterval(tick, 8000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  const refreshMarkets = useCallback(async () => {
    setMarketsLoading(true)
    setMarketsError(null)
    try {
      const res = await api.markets()
      setMarkets(res.markets ?? [])
    } catch (err) {
      setMarketsError((err as Error).message.slice(0, 220))
    } finally {
      setMarketsLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshMarkets()
  }, [refreshMarkets])

  const refreshRuns = useCallback(async () => {
    setPastRunsLoading(true)
    setPastRunsError(null)
    try {
      const res = await api.runs(25)
      setPastRuns(res.runs ?? [])
    } catch (err) {
      setPastRunsError((err as Error).message.slice(0, 220))
    } finally {
      setPastRunsLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshRuns()
  }, [refreshRuns])

  // ── Run handler ─────────────────────────────────────────────────────────
  const onRun = useCallback(async () => {
    if (!prompt.trim()) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    setSelectedRunId(null)
    dispatch({ type: 'start' })

    try {
      await startRun(
        {
          prompt,
          market_id: selectedMarket?.id ?? null,
          amount_usdc: amount,
          min_verified_peers: minVerified,
          verify,
        },
        (ev: RunEvent) => {
          dispatch({ type: 'event', ev, ts: Date.now() / 1000 })
        },
        ctrl.signal,
      )
    } catch (err) {
      const e = err as Error
      if (e.name !== 'AbortError') {
        dispatch({
          type: 'event',
          ts: Date.now() / 1000,
          ev: {
            event: 'error',
            data: { message: e.message ?? 'Unknown error' },
          },
        })
      }
    } finally {
      dispatch({ type: 'finish' })
      void refreshRuns()
    }
  }, [prompt, selectedMarket, amount, minVerified, verify, refreshRuns])

  const onCancel = useCallback(() => {
    abortRef.current?.abort()
    dispatch({ type: 'cancel' })
  }, [])

  const onOpenRun = useCallback(async (runId: string) => {
    abortRef.current?.abort()
    try {
      const saved = await api.run(runId)
      setSelectedRunId(runId)
      setPrompt(saved.prompt)
      setAmount(saved.amountUsdc)
      setMinVerified(saved.minVerifiedPeers)
      setVerify(saved.verify)
      setSelectedMarket(
        saved.marketId ? markets.find((m) => m.id === saved.marketId) ?? null : null,
      )
      dispatch({ type: 'loadHistory', events: saved.events })
    } catch (err) {
      dispatch({
        type: 'event',
        ts: Date.now() / 1000,
        ev: {
          event: 'error',
          data: { message: (err as Error).message ?? 'Could not load saved run' },
        },
      })
    }
  }, [markets])

  const onDeleteRun = useCallback(async (runId: string) => {
    try {
      await api.deleteRun(runId)
      if (selectedRunId === runId) {
        setSelectedRunId(null)
        dispatch({ type: 'reset' })
      }
      await refreshRuns()
    } catch (err) {
      setPastRunsError((err as Error).message.slice(0, 220))
    }
  }, [selectedRunId, refreshRuns])

  // ── Derived ─────────────────────────────────────────────────────────────
  const orderedPeers = useMemo(
    () => runState.peerOrder.map((id) => runState.peers[id]).filter(Boolean),
    [runState.peerOrder, runState.peers],
  )

  return (
    <div className="app">
      <Topbar health={health} network={wallet?.network} />

      <main className="main">
        <Sidebar
          wallet={wallet}
          walletError={walletError}
          topology={topology}
          topologyError={topologyError}
          markets={markets}
          marketsError={marketsError}
          marketsLoading={marketsLoading}
          selectedMarketId={selectedMarket?.id ?? null}
          onSelectMarket={setSelectedMarket}
          onRefreshMarkets={refreshMarkets}
        />

        <div className="workspace">
          <PastRuns
            runs={pastRuns}
            loading={pastRunsLoading}
            error={pastRunsError}
            selectedRunId={selectedRunId}
            onRefresh={refreshRuns}
            onOpen={onOpenRun}
            onDelete={onDeleteRun}
          />

          <RunPanel
            selectedMarket={selectedMarket}
            onClearMarket={() => setSelectedMarket(null)}
            prompt={prompt}
            onPromptChange={setPrompt}
            amount={amount}
            onAmountChange={setAmount}
            minVerified={minVerified}
            onMinVerifiedChange={setMinVerified}
            verify={verify}
            onVerifyChange={setVerify}
            running={runState.running}
            onRun={onRun}
            onCancel={onCancel}
            timeline={runState.timeline}
            fatalError={runState.fatalError}
          />

          {orderedPeers.length > 0 && (
            <section>
              <div className="section-heading">
                <span className="section-label">Peer Receipts</span>
                <span className="mono-soft">
                  {orderedPeers.filter((p) => p.verified).length}/
                  {orderedPeers.length} verified
                </span>
              </div>
              <div className="peer-grid">
                {orderedPeers.map((peer) => (
                  <PeerCard key={peer.peerId} peer={peer} />
                ))}
              </div>
            </section>
          )}

          {runState.consensus && (
            <Consensus consensus={runState.consensus} />
          )}

          {runState.tradeDecision && (
            <Trade
              decision={runState.tradeDecision}
              result={runState.tradeResult}
              network={wallet?.network}
            />
          )}
        </div>
      </main>

      <footer className="footer">
        <span className="pipes">
          <b>AXL</b> P2P · <b>REE</b> verifiable inference · <b>Delphi</b> on-chain
          settlement
        </span>
      </footer>
    </div>
  )
}

export default App
