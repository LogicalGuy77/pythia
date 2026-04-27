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
import { ResearchContext } from './components/ResearchContext'

import { animate, createScope, stagger } from 'animejs'

const DEFAULT_PROMPT =
  'Will ETH be above $3000 at the end of 2025? Give a numeric probability percentage.'

function App() {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const animeScopeRef = useRef<ReturnType<typeof createScope> | null>(null)

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

  // ── Entrance animation (scoped) ─────────────────────────────────────────
  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const scope = createScope({ root: rootRef }).add(() => {
      animate('.topbar', {
        opacity: [0, 1],
        translateY: [-10, 0],
        duration: 900,
        ease: 'outExpo',
      })

      animate('.reveal', {
        opacity: [0, 1],
        translateY: [18, 0],
        duration: 900,
        delay: stagger(70, { start: 120 }),
        ease: 'outExpo',
      })
    })

    animeScopeRef.current = scope
    return () => scope.revert()
  }, [])

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

  // Animate newly added peer cards without re-animating existing ones.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const nodes = Array.from(
      root.querySelectorAll<HTMLElement>('.peer-card:not([data-animated="1"])'),
    )
    if (nodes.length === 0) return

    for (const n of nodes) n.dataset.animated = '1'

    animate(nodes, {
      opacity: [0, 1],
      translateY: [14, 0],
      scale: [0.985, 1],
      duration: 650,
      delay: stagger(55),
      ease: 'outExpo',
    })
  }, [orderedPeers.length])

  return (
    <div ref={rootRef} className="app scene">
      <div className="scene-bg" aria-hidden="true">
        <div className="scene-aurora" />
        <div className="scene-grid" />
        <div className="scene-noise" />
      </div>

      <Topbar health={health} network={wallet?.network} />

      <main className="main">
        <div className="reveal">
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
        </div>

        <div className="workspace">
          <section className="hero reveal">
            <div className="hero-eyebrow">
              <div className="hero-badge-row">
                <span className="badge badge--brand">oracle studio</span>
                {runState.running && (
                  <span className="badge badge--brand">
                    <span className="dot dot--brand" /> live
                  </span>
                )}
              </div>
              <div className="hero-stat-row">
                <div className="hero-stat-chip">
                  <span className="hero-stat-num">{topology?.peerCount ?? '—'}</span>
                  <span className="hero-stat-label">peers</span>
                </div>
                <div className="hero-stat-div" />
                <div className="hero-stat-chip">
                  <span className="hero-stat-num">{pastRuns.length}</span>
                  <span className="hero-stat-label">runs</span>
                </div>
                <div className="hero-stat-div" />
                <div className="hero-stat-chip">
                  <span className="hero-stat-num hero-stat-num--sm">
                    {wallet ? wallet.network : '—'}
                  </span>
                  <span className="hero-stat-label">network</span>
                </div>
                <div className="hero-stat-div" />
                <div className="hero-stat-chip">
                  <span className="hero-stat-num hero-stat-num--sm">
                    {wallet ? `${parseFloat(String(wallet.token.formatted ?? 0)).toFixed(0)} USDC` : '—'}
                  </span>
                  <span className="hero-stat-label">balance</span>
                </div>
              </div>
            </div>
            <h1 className="hero-title">
              Turn a prompt into a<br />
              <span className="hero-title-grad">provable market move.</span>
            </h1>
            <p className="hero-sub">
              Peer-sourced inference, verifiable receipts, on-chain settlement—
              <br />all in one live view.
            </p>
            <div className="hero-actions">
              <button
                type="button"
                className="btn btn--primary btn--lg"
                onClick={onRun}
                disabled={runState.running || !prompt.trim()}
              >
                <svg width="11" height="11" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9"/></svg>
                Run inference
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={refreshMarkets}
                disabled={marketsLoading}
              >
                Refresh markets
              </button>
            </div>
          </section>

          <div className="reveal">
            <PastRuns
              runs={pastRuns}
              loading={pastRunsLoading}
              error={pastRunsError}
              selectedRunId={selectedRunId}
              onRefresh={refreshRuns}
              onOpen={onOpenRun}
              onDelete={onDeleteRun}
            />
          </div>

          <div className="reveal">
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
          </div>

          {runState.research && (
            <div className="reveal">
              <ResearchContext research={runState.research} />
            </div>
          )}

          {orderedPeers.length > 0 && (
            <section className="reveal">
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
            <div className="reveal">
              <Consensus consensus={runState.consensus} />
            </div>
          )}

          {runState.tradeDecision && (
            <div className="reveal">
              <Trade
                decision={runState.tradeDecision}
                result={runState.tradeResult}
                network={wallet?.network}
              />
            </div>
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
