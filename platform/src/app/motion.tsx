/**
 * Shared motion primitives for the «Отсчёт» cabinet — the same weighted, physics-based
 * language as the landing film, made interruptible. Springs preserve velocity when the
 * target changes mid-flight, so a tap during a settle carries through instead of snapping.
 * Transform-only (compositor-friendly), rAF-driven, and fully collapsed under
 * `prefers-reduced-motion` (targets jump, no loop). No dependencies.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';

type SpringConfig = { stiffness: number; damping: number; mass: number; eps: number };

// The cabinet's motion vocabulary in one place — tuned once, reused everywhere.
export const SPRING = {
  press: { stiffness: 1100, damping: 42, mass: 1, eps: 0.0006 }, // snappy dip + settle
  travel: { stiffness: 560, damping: 44, mass: 1.05, eps: 0.15 }, // indicator glide
  gentle: { stiffness: 240, damping: 30, mass: 1, eps: 0.05 },
} satisfies Record<string, SpringConfig>;

export function prefersReducedMotion(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

type Spring = { to: (v: number) => void; set: (v: number) => void; stop: () => void };

// Semi-implicit Euler with fixed sub-steps: stable at these stiffnesses, and velocity is
// carried across retargets — the essence of interruptible motion.
function makeSpring(cfg: SpringConfig, onFrame: (v: number) => void, onRest?: () => void): Spring {
  let value = 0;
  let target = 0;
  let vel = 0;
  let raf = 0;
  let last = 0;
  const tick = (t: number) => {
    const dt = Math.min(0.064, (t - last) / 1000) || 0;
    last = t;
    const steps = Math.max(1, Math.ceil(dt / 0.008));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const f = -cfg.stiffness * (value - target) - cfg.damping * vel;
      vel += (f / cfg.mass) * h;
      value += vel * h;
    }
    onFrame(value);
    if (Math.abs(target - value) < cfg.eps && Math.abs(vel) < cfg.eps * 8) {
      value = target;
      vel = 0;
      raf = 0;
      onFrame(value);
      onRest?.();
    } else raf = requestAnimationFrame(tick);
  };
  return {
    set(v) {
      value = target = v;
      vel = 0;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      onFrame(v);
    },
    to(v) {
      target = v;
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
/**
 * Physics press feedback: the surface dips on pointer-down and springs back with a hint of
 * overshoot on release. Interruptible — a re-press mid-return keeps its velocity. Drives an
 * inline transform, so it composes over the CSS baseline and wins during `:active`.
 */
export function usePress<E extends HTMLElement = HTMLElement>(depth = 0.95) {
  const ref = useRef<E>(null);
  const spring = useRef<Spring | null>(null);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const el = ref.current;
    if (!el) return;
    const s = makeSpring(SPRING.press, (v) => {
      el.style.transform = v < 0.9999 ? `scale(${v})` : '';
    });
    s.set(1);
    spring.current = s;
    return () => {
      s.stop();
      el.style.transform = '';
      spring.current = null;
    };
  }, []);
  const down = useCallback(() => spring.current?.to(depth), [depth]);
  const up = useCallback(() => spring.current?.to(1), []);
  return { ref, onPointerDown: down, onPointerUp: up, onPointerLeave: up, onPointerCancel: up };
}

/** `<a>` / `<button>` with the physics press baked in — drop-in for navigation and actions. */
export function PressLink({ depth, ...props }: { depth?: number } & ComponentPropsWithoutRef<'a'>) {
  const p = usePress<HTMLAnchorElement>(depth);
  return <a {...props} ref={p.ref} onPointerDown={p.onPointerDown} onPointerUp={p.onPointerUp} onPointerLeave={p.onPointerLeave} onPointerCancel={p.onPointerCancel} />;
}
export function PressButton({ depth, ...props }: { depth?: number } & ComponentPropsWithoutRef<'button'>) {
  const p = usePress<HTMLButtonElement>(depth);
  return <button {...props} ref={p.ref} onPointerDown={p.onPointerDown} onPointerUp={p.onPointerUp} onPointerLeave={p.onPointerLeave} onPointerCancel={p.onPointerCancel} />;
}

/**
 * One brand bar that travels to the active item — the cabinet's shared-element move for the
 * mobile tab rail and the sidebar. translate-only (never distorts), measured in the
 * container's own layout coordinates (scroll-proof), hidden until an active target exists,
 * and a clean jump under reduced motion.
 */
export function MovingUnderline({
  containerRef,
  activeKey,
  orientation = 'horizontal',
  size = 24,
  thickness = 3,
  className = '',
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  activeKey: string;
  orientation?: 'horizontal' | 'vertical';
  size?: number;
  thickness?: number;
  className?: string;
}) {
  const bar = useRef<HTMLSpanElement>(null);
  const spring = useRef<Spring | null>(null);
  const [visible, setVisible] = useState(false);
  const horiz = orientation === 'horizontal';

  const measure = useCallback(() => {
    const c = containerRef.current;
    const b = bar.current;
    if (!c || !b) return;
    const active = c.querySelector<HTMLElement>('[aria-current="page"]');
    if (!active) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const pos = horiz ? active.offsetLeft + active.offsetWidth / 2 - size / 2 : active.offsetTop + active.offsetHeight / 2 - size / 2;
    const paint = (v: number) => {
      if (bar.current) bar.current.style.transform = horiz ? `translateX(${v}px)` : `translateY(${v}px)`;
    };
    if (!spring.current) {
      spring.current = makeSpring(SPRING.travel, paint);
      spring.current.set(pos);
    } else if (prefersReducedMotion()) spring.current.set(pos);
    else spring.current.to(pos);
  }, [containerRef, horiz, size]);

  useLayoutEffect(() => {
    measure();
  }, [activeKey, measure]);
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(c);
    addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      removeEventListener('resize', measure);
      spring.current?.stop();
      spring.current = null;
    };
  }, [containerRef, measure]);

  return (
    <span
      ref={bar}
      aria-hidden="true"
      className={className}
      style={{
        position: 'absolute',
        ...(horiz ? { top: 0, left: 0, width: size, height: thickness } : { left: 0, top: 0, width: thickness, height: size }),
        borderRadius: 999,
        background: 'var(--primary)',
        opacity: visible ? 1 : 0,
        transition: 'opacity var(--dur-2) var(--ease-out)',
        pointerEvents: 'none',
        willChange: 'transform',
      }}
    />
  );
}
