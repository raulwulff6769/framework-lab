import { SYMBOL, WORDMARK } from '../brand/logo';

/** «Риска»: dial ring with the index dot. `knockout` must match the surface the mark sits on. */
export function BrandSymbol({ className = '', knockout = 'var(--bg)', spinning = false }: { className?: string; knockout?: string; spinning?: boolean }) {
  const s = SYMBOL;
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <circle cx={s.cx} cy={s.cy} r={s.r} fill="none" stroke="currentColor" strokeWidth={s.stroke} />
      <g className={spinning ? 'orbit-dot' : undefined}>
        <circle cx={s.dot.cx} cy={s.dot.cy} r={s.dot.r + s.dot.gap} fill={knockout} />
        <circle cx={s.dot.cx} cy={s.dot.cy} r={s.dot.r} fill="var(--signal-graphic)" />
      </g>
    </svg>
  );
}

/**
 * Inline branded loader: the index dot sweeps the dial ring (a brisk lap, not the ambient
 * hero orbit). Sizes to the surrounding text by default and inherits `currentColor` for the
 * ring track. `tone="brand"` uses the orange index dot for neutral surfaces; `tone="current"`
 * keeps the dot monochrome for filled buttons where the signal colour would vanish.
 */
export function BrandSpinner({ size = '1em', tone = 'brand', className = '' }: { size?: number | string; tone?: 'brand' | 'current'; className?: string }) {
  const s = SYMBOL;
  return (
    <svg className={className} style={{ width: size, height: size, flex: 'none' }} viewBox="0 0 64 64" role="status" aria-label="Загрузка" focusable="false">
      <circle cx={s.cx} cy={s.cy} r={s.r} fill="none" stroke="currentColor" strokeWidth={s.stroke} opacity={0.28} />
      <g className="brand-spinner-dot">
        <circle cx={s.dot.cx} cy={s.dot.cy} r={s.dot.r} fill={tone === 'brand' ? 'var(--signal-graphic)' : 'currentColor'} />
      </g>
    </svg>
  );
}

export function BrandWordmark({ className = '' }: { className?: string }) {
  const { dots } = WORDMARK;
  return (
    <svg className={className} viewBox={WORDMARK.viewBox} aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor">
        <path d={WORDMARK.letters.flatMap((l) => l.v).join('')} strokeWidth={WORDMARK.vertical} />
        <path d={WORDMARK.letters.flatMap((l) => l.h).join('')} strokeWidth={WORDMARK.horizontal} />
      </g>
      <circle cx={dots.x[0]} cy={dots.y} r={dots.r} fill="currentColor" />
      <circle cx={dots.x[1]} cy={dots.y} r={dots.r} fill="var(--signal-graphic)" />
    </svg>
  );
}

export function BrandLockup({ size = 28, knockout, className = '' }: { size?: number; knockout?: string; className?: string }) {
  // the wordmark x-height optically matches the ring's inner diameter
  return (
    <span className={`inline-flex items-center text-foreground ${className}`} style={{ gap: size * 0.34 }}>
      <span className="block shrink-0" style={{ width: size, height: size }}>
        <BrandSymbol knockout={knockout} className="h-full w-full" />
      </span>
      <span className="block shrink-0" style={{ width: size * 3.05, height: size * 0.766 }}>
        <BrandWordmark className="h-full w-full" />
      </span>
    </span>
  );
}
