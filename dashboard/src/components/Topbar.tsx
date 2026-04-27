import type { Health } from '../types'

interface Props {
  health: Health | null
  network?: string
}

function ServiceStatus({
  label,
  ok,
  detail,
}: {
  label: string
  ok: boolean | undefined
  detail?: string
}) {
  const klass =
    ok === undefined ? 'dot' : ok ? 'dot dot--live' : 'dot dot--down'
  return (
    <div className="status-pill" title={detail}>
      <span className={klass}></span>
      <span className="label">{label}</span>
    </div>
  )
}

export function Topbar({ health, network }: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-logo">
          <svg width="20" height="20" viewBox="0 0 32 32" fill="none">
            <defs>
              <linearGradient id="logoGrad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                <stop offset="0%"   stopColor="#fda4af" />
                <stop offset="45%"  stopColor="#e11d48" />
                <stop offset="100%" stopColor="#9f1239" />
              </linearGradient>
              <filter id="logoGlow">
                <feGaussianBlur stdDeviation="1.5" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            </defs>
            {/* Outer hex */}
            <path
              d="M16 4 L27 10 L27 22 L16 28 L5 22 L5 10 Z"
              stroke="url(#logoGrad)"
              strokeWidth="1.5"
              strokeLinejoin="round"
              fill="rgba(225,29,72,0.08)"
            />
            {/* Inner triangle oracle symbol */}
            <path
              d="M16 10 L22 20 L10 20 Z"
              stroke="url(#logoGrad)"
              strokeWidth="1.2"
              strokeLinejoin="round"
              fill="rgba(225,29,72,0.14)"
            />
            <circle cx="16" cy="16" r="2.5" fill="url(#logoGrad)" filter="url(#logoGlow)" />
          </svg>
        </div>
        <div>
          <span className="brand-name">PYTHIA</span>
          <span className="brand-sub">consensus · receipts · settlement</span>
        </div>
      </div>

      <div className="statuses">
        <ServiceStatus
          label="AXL"
          ok={health?.services.axl?.ok}
          detail={health?.services.axl?.error}
        />
        <ServiceStatus
          label="REE"
          ok={health?.services.ree?.ok}
        />
        <ServiceStatus
          label="Delphi"
          ok={health?.services.delphi?.ok}
          detail={health?.services.delphi?.error}
        />
        <ServiceStatus
          label="Exa"
          ok={health?.services.exa?.ok}
          detail={health?.services.exa?.error}
        />
        {network && (
          <div className="status-pill">
            <span className="dot dot--brand"></span>
            <span className="label">{network}</span>
          </div>
        )}
      </div>
    </header>
  )
}
