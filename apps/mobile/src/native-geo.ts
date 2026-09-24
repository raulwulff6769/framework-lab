import { BackgroundGeolocation, type Location } from '@capgo/background-geolocation';

declare const __APP_VERSION__: string;

type NativeLocation = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  altitude: number | null;
  speed: number | null;
  bearing: number | null;
  time: number;
};

type NativeError = { code: string; message: string };
type NativeCallback = (loc: NativeLocation | null, err: NativeError | null) => void;

interface NativeGeoContract {
  platform: 'android';
  version: string;
  addWatcher(
    opts: { backgroundTitle: string; backgroundMessage: string; distanceFilter?: number },
    cb: NativeCallback,
  ): Promise<string>;
  removeWatcher(id: string): Promise<void>;
  openSettings(): Promise<void>;
}

declare global {
  interface Window {
    ItlesNative: NativeGeoContract;
  }
}

const callbacks = new Map<string, NativeCallback>();
let nextWatcherId = 0;
let nativeWatcherStarted = false;
let operationQueue: Promise<void> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toNativeError(error: unknown): NativeError {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown };
    return {
      code: typeof candidate.code === 'string' && candidate.code ? candidate.code : 'LOCATION_ERROR',
      message:
        typeof candidate.message === 'string' && candidate.message
          ? candidate.message
          : 'Location tracking failed.',
    };
  }
  return {
    code: 'LOCATION_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}

function notifyAll(location: NativeLocation | null, error: NativeError | null): void {
  for (const callback of callbacks.values()) {
    callback(location, error);
  }
}

function onNativeLocation(location?: Location, error?: Error & { code?: string }): void {
  if (error) {
    notifyAll(null, toNativeError(error));
    return;
  }
  if (!location) return;

  notifyAll(
    {
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: finiteOrNull(location.accuracy),
      altitude: finiteOrNull(location.altitude),
      speed: finiteOrNull(location.speed),
      bearing: finiteOrNull(location.bearing),
      time: finiteOrNull(location.time) ?? Date.now(),
    },
    null,
  );
}

const ItlesNative: NativeGeoContract = {
  platform: 'android',
  version: __APP_VERSION__,

  async addWatcher(opts, callback): Promise<string> {
    const id = `itles-${Date.now().toString(36)}-${(++nextWatcherId).toString(36)}`;
    callbacks.set(id, callback);

    try {
      await serialize(async () => {
        if (!callbacks.has(id) || nativeWatcherStarted) return;

        // Also request notifications if location permission was granted earlier.
        const permissionStatus = await BackgroundGeolocation.requestPermissions({
          permissions: ['location', 'notification'],
        });
        if (permissionStatus.location !== 'granted') {
          throw new Error('Location permission was not granted.');
        }

        await BackgroundGeolocation.start(
          {
            backgroundTitle: opts.backgroundTitle,
            backgroundMessage: opts.backgroundMessage,
            distanceFilter: opts.distanceFilter,
            requestPermissions: true,
            stale: false,
          },
          onNativeLocation,
        );
        nativeWatcherStarted = true;
      });
      return id;
    } catch (error) {
      callbacks.delete(id);
      callback(null, toNativeError(error));
      throw error;
    }
  },

  async removeWatcher(id): Promise<void> {
    callbacks.delete(id);
    await serialize(async () => {
      if (callbacks.size > 0 || !nativeWatcherStarted) return;
      await BackgroundGeolocation.stop();
      nativeWatcherStarted = false;
    });
  },

  openSettings: () => BackgroundGeolocation.openSettings(),
};

window.ItlesNative = ItlesNative;
