import type { ConsensusEvent } from '../types'

interface Props {
  consensus: ConsensusEvent
}

function decisionFor(p: number | null) {
  if (p === null) return { label: 'no signal', klass: 'badge badge--warning' }
  if (p > 0.65)   return { label: 'lean YES',  klass: 'badge badge--success' }
  if (p < 0.35)   return { label: 'lean NO',   klass: 'badge badge--danger' }
  return { label: 'uncertain', klass: 'badge badge--warning' }
}

function describeRange(p: number | null) {
  if (p === null) return 'No probability could be extracted from peer outputs.'
  if (p > 0.65)   return 'Strong YES — would buy YES shares if a market is selected.'
  if (p < 0.35)   return 'Strong NO — would buy NO shares if a market is selected.'
  return 'Inside 35–65% uncertainty band — Pythia abstains from trading.'
}

export function Consensus({ consensus }: Props) {
  const p = consensus.consensusProbability
  const pct = p === null ? 0 : Math.max(0, Math.min(1, p))
  const dec = decisionFor(p)

  // Half-circle gauge — angle goes from -90 (left, 0%) to +90 (right, 100%).
  // We draw the arc using stroke-dasharray on a path.
  const radius = 80
  const circumference = Math.PI * radius
  const dashOffset = circumference * (1 - pct)

  return (
    <section className="card consensus-card">
      <div className="card-header">
        <div className="card-header-title">
          <span>Consensus</span>
        </div>
        <span className={dec.klass}>{dec.label}</span>
      </div>
      <div className="card-body">
        <div className="gauge">
          <svg viewBox="0 0 200 110">
            <defs>
              <linearGradient id="gaugeG" x1="0" y1="0" x2="200" y2="0" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#ef4444" />
                <stop offset="40%" stopColor="#f59e0b" />
                <stop offset="75%" stopColor="#fcd34d" />
                <stop offset="100%" stopColor="#4ade80" />
              </linearGradient>
              <filter id="gaugeGlow">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            </defs>
            {/* Track */}
            <path
              d="M 20 100 A 80 80 0 0 1 180 100"
              fill="none"
              stroke="rgba(245,158,11,0.1)"
              strokeWidth="12"
              strokeLinecap="round"
            />
            {/* Glow layer */}
            <path
              d="M 20 100 A 80 80 0 0 1 180 100"
              fill="none"
              stroke="url(#gaugeG)"
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              opacity="0.4"
              filter="url(#gaugeGlow)"
              style={{ transition: 'stroke-dashoffset 700ms cubic-bezier(0.4,0,0.2,1)' }}
            />
            {/* Crisp foreground */}
            <path
              d="M 20 100 A 80 80 0 0 1 180 100"
              fill="none"
              stroke="url(#gaugeG)"
              strokeWidth="12"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              style={{ transition: 'stroke-dashoffset 700ms cubic-bezier(0.4,0,0.2,1)' }}
            />
          </svg>
          <div className="gauge-readout">
            <div className="num">{p === null ? '—' : `${(pct * 100).toFixed(0)}%`}</div>
            <div className="label">consensus probability</div>
          </div>
        </div>

        <div className="consensus-detail">
          <div>
            <h3>{describeRange(p)}</h3>
          </div>
          <div className="kv" style={{ paddingTop: 0 }}>
            <span className="k">Verified peers</span>
            <span className="v">
              {consensus.verifiedCount} / {consensus.totalCount}
            </span>
          </div>
          {consensus.perPeer.length > 0 && (
            <div className="peer-prob-list">
              {consensus.perPeer.map((p) => (
                <div key={p.peerId} className="item">
                  <span>{p.shortId}</span>
                  <span>
                    {p.probability === null
                      ? '—'
                      : `${(p.probability * 100).toFixed(1)}%`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
