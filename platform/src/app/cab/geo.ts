// Location providers for the phone-in-the-cab mode. The browser watch is backed up by polling
// because Safari can stop delivering watch callbacks after the page was hidden; the Android shell
// exposes a foreground-service provider (apps/mobile/src/native-geo.ts) that keeps running with the
// screen off.
export interface GeoFix {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  altitude: number | null;
  speed: number | null; // m/s
  bearing: number | null;
  time: number; // ms since epoch as reported by the device
}

export interface GeoProvider {
  name: string;
  background: boolean;
  start(onFix: (f: GeoFix) => void, onError: (e: { code: number; message: string }) => void): void;
  stop(): void;
}

const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The server rejects records more than 10 minutes in the future or with implausible dates; a
 * position timestamp that disagrees with the phone clock by more than 5 minutes (seen with some
 * WebKit builds and cached fixes) is replaced by the time of arrival.
 */
export function fixTime(t: number, now = Date.now()): { t: number; corrected: boolean } {
  if (!Number.isFinite(t) || Math.abs(t - now) > 5 * 60e3) return { t: now, corrected: true };
  return { t, corrected: false };
}

function browserProvider(): GeoProvider {
  let watch: number | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let last = 0;
  return {
    name: 'браузер (watchPosition + опрос)',
    background: false,
    start(onFix, onError) {
      if (!navigator.geolocation) {
        onError({ code: 2, message: 'В этом браузере нет API геопозиции' });
        return;
      }
      const ok = (p: GeolocationPosition) => {
        last = Date.now();
        onFix({
          latitude: p.coords.latitude,
          longitude: p.coords.longitude,
          accuracy: num(p.coords.accuracy),
          altitude: num(p.coords.altitude),
          speed: num(p.coords.speed),
          bearing: num(p.coords.heading),
          time: p.timestamp,
        });
      };
      const fail = (e: GeolocationPositionError) => onError({ code: e.code, message: e.message });
      const opts: PositionOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 };
      navigator.geolocation.getCurrentPosition(ok, fail, opts);
      watch = navigator.geolocation.watchPosition(ok, fail, opts);
      poll = setInterval(() => {
        if (Date.now() - last > 15_000) navigator.geolocation.getCurrentPosition(ok, fail, { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 });
      }, 10_000);
    },
    stop() {
      if (watch !== null) navigator.geolocation.clearWatch(watch);
      if (poll) clearInterval(poll);
      watch = null;
      poll = null;
    },
  };
}

interface NativeGeo {
  addWatcher(opts: { backgroundTitle: string; backgroundMessage: string; distanceFilter?: number }, cb: (loc: GeoFix | null, err: { code: string; message: string } | null) => void): Promise<string>;
  removeWatcher(id: string): Promise<void>;
}

function nativeProvider(n: NativeGeo): GeoProvider {
  let id: string | null = null;
  return {
    name: 'приложение Android (фоновая служба)',
    background: true,
    start(onFix, onError) {
      n.addWatcher({ backgroundTitle: 'ITles: запись маршрута', backgroundMessage: 'Координаты передаются диспетчеру', distanceFilter: 0 }, (loc, err) => {
        if (err) onError({ code: /permission/i.test(err.message) ? 1 : 2, message: err.message });
        else if (loc) onFix(loc);
      })
        .then((w) => (id = w))
        .catch((e) => onError({ code: 1, message: String(e?.message ?? e) }));
    },
    stop() {
      if (id) n.removeWatcher(id).catch(() => {});
      id = null;
    },
  };
}

export function locationProvider(): GeoProvider {
  const n = (window as any).ItlesNative as NativeGeo | undefined;
  return n?.addWatcher ? nativeProvider(n) : browserProvider();
}
