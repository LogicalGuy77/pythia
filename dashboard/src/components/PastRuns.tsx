import type { RunSummary } from '../types'

interface Props {
  runs: RunSummary[]
  loading: boolean
  error: string | null
  selectedRunId: string | null
  onRefresh: () => void
  onOpen: (runId: string) => void
  onDelete: (runId: string) => void
}

function shortHash(value: string | undefined) {
  if (!value) return null
  return `${value.slice(0, 10)}…${value.slice(-6)}`
}

function fmtTime(ts: number) {
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function statusClass(status: RunSummary['status']) {
  if (status === 'completed') return 'badge badge--success'
  if (status === 'failed' || status === 'cancelled') return 'badge badge--danger'
  return 'badge badge--brand'
}

export function PastRuns({
  runs,
  loading,
  error,
  selectedRunId,
  onRefresh,
  onOpen,
  onDelete,
}: Props) {
  return (
    <section className="card history-card">
      <div className="card-header">
        <div className="card-header-title">
          <span>Past Runs</span>
          {loading && <span className="dot dot--brand" />}
        </div>
        <button
          className="btn btn--ghost"
          style={{ padding: '4px 10px', fontSize: 11 }}
          onClick={onRefresh}
          disabled={loading}
          type="button"
        >
          Refresh
        </button>
      </div>
      <div className="card-body">
        {error ? (
          <div className="empty">{error}</div>
        ) : loading && runs.length === 0 ? (
          <div className="history-list">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" style={{ height: 68 }} />
            ))}
          </div>
        ) : runs.length === 0 ? (
          <div className="empty">No saved runs yet. Start an inference to create one.</div>
        ) : (
          <div className="history-list">
            {runs.map((run) => {
              const consensus = run.summary.consensus?.consensusProbability
              const tx = shortHash(run.summary.trade_result?.transactionHash)
              return (
                <div
                  key={run.id}
                  className="history-row"
                  data-selected={run.id === selectedRunId}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(run.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onOpen(run.id)
                    }
                  }}
                >
                  <div className="history-row-top">
                    <span className={statusClass(run.status)}>{run.status}</span>
                    <span className="history-time">{fmtTime(run.createdAt)}</span>
                  </div>
                  <div className="history-prompt">{run.prompt}</div>
                  <div className="history-meta">
                    {consensus !== undefined && consensus !== null && (
                      <span>{(consensus * 100).toFixed(1)}% consensus</span>
                    )}
                    {tx && <span>tx {tx}</span>}
                    {run.marketId ? <span>market selected</span> : <span>inference only</span>}
                    <span>{run.verify ? 'verified' : 'verify skipped'}</span>
                  </div>
                  <button
                    type="button"
                    className="history-delete"
                    aria-label="Delete saved run"
                    onClick={(event) => {
                      event.stopPropagation()
                      onDelete(run.id)
                    }}
                  >
                    Delete
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
