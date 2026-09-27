import { useEffect, useRef, useState } from 'react';
import { BrandSymbol, BrandWordmark } from './brand';

/**
 * Cold-launch intro for the «Отсчёт» cabinet — the first frame both native shells and the web app
 * hand off to. The dial ring draws itself, the index dot ignites, the wordmark settles: the same
 * count-from-zero gesture as the landing film, in ~1s. It never blocks — as soon as the session
 * check resolves (`ready`) the intro plays out its minimum beat and lifts. Reduced-motion collapses
 * the choreography to a calm cross-fade (handled in CSS).
 */
export function LaunchIntro({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const started = useRef(performance.now());

  useEffect(() => {
    if (!ready) return;
    // let the ring finish drawing before we lift — but cap the wait so a slow session never stalls the app
    const MIN = 950;
    const wait = Math.max(0, MIN - (performance.now() - started.current));
    const lift = window.setTimeout(() => setLeaving(true), wait);
    return () => window.clearTimeout(lift);
  }, [ready]);

  useEffect(() => {
    if (!leaving) return;
    const done = window.setTimeout(onDone, 460);
    return () => window.clearTimeout(done);
  }, [leaving, onDone]);

  return (
    <div className={`intro ${leaving ? 'intro--leaving' : ''}`} role="status" aria-label="Отсчёт запускается">
      <div className="intro__grain" aria-hidden="true" />
      <div className="intro__stage">
        <span className="intro__mark">
          <BrandSymbol className="h-full w-full" />
        </span>
        <span className="intro__word">
          <BrandWordmark className="h-full w-full" />
        </span>
      </div>
      <span className="intro__tag eyebrow">Моточасы · пробег · местоположение</span>
    </div>
  );
}
