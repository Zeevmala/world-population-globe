import { IconCheck } from './icons'

export interface LoadStep {
  label: string
  done: boolean
}

interface LoaderProps {
  message: string
  /** Concrete facts about the payload — cells, megabytes — not a fake percentage. */
  detail?: string
  /** Ordered stages, ticked off as each real milestone lands. */
  steps?: LoadStep[]
}

/**
 * Boot overlay. A bare spinner answers "is it stuck?" with a shrug; this answers
 * "what is loading, and how far in are we?" using milestones the app actually knows —
 * no invented progress percentage.
 */
export function Loader({ message, detail, steps }: LoaderProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-0 z-40 flex items-center justify-center bg-[#05070d]/85 px-6 backdrop-blur-sm"
    >
      <div className="hud-panel hud-fade w-full max-w-xs px-4 py-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="h-5 w-5 shrink-0 rounded-full border-2 border-white/20 border-t-white/85 motion-safe:animate-spin"
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-white/90">{message}</p>
            {detail ? <p className="mt-0.5 text-[11px] text-white/60">{detail}</p> : null}
          </div>
        </div>

        <div className="hud-bar mt-3.5" aria-hidden="true" />

        {steps?.length ? (
          <ul className="mt-3 space-y-1.5">
            {steps.map((s) => (
              <li key={s.label} className="flex items-center gap-2 text-[11px]">
                {s.done ? (
                  <IconCheck className="h-3.5 w-3.5 shrink-0 text-emerald-300/90" />
                ) : (
                  <span
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 rounded-full border border-white/25"
                  />
                )}
                <span className={s.done ? 'text-white/85' : 'text-white/60'}>{s.label}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}
