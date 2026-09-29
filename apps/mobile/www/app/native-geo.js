(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __esm = (fn, res, err) => function __init() {
    if (err) throw err[0];
    try {
      return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
    } catch (e) {
      throw err = [e], e;
    }
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // node_modules/@capacitor/core/dist/index.js
  var ExceptionCode, CapacitorException, getPlatformId, createCapacitor, initCapacitorGlobal, Capacitor, registerPlugin, WebPlugin, encode, decode, CapacitorCookiesPluginWeb, CapacitorCookies, readBlobAsBase64, normalizeHttpHeaders, buildUrlParams, buildRequestInit, CapacitorHttpPluginWeb, CapacitorHttp, SystemBarsStyle, SystemBarType, SystemBarsPluginWeb, SystemBars;
  var init_dist = __esm({
    "node_modules/@capacitor/core/dist/index.js"() {
      (function(ExceptionCode2) {
        ExceptionCode2["Unimplemented"] = "UNIMPLEMENTED";
        ExceptionCode2["Unavailable"] = "UNAVAILABLE";
      })(ExceptionCode || (ExceptionCode = {}));
      CapacitorException = class extends Error {
        constructor(message, code, data) {
          super(message);
          this.message = message;
          this.code = code;
          this.data = data;
        }
      };
      getPlatformId = (win) => {
        var _a, _b;
        if (win === null || win === void 0 ? void 0 : win.androidBridge) {
          return "android";
        } else if ((_b = (_a = win === null || win === void 0 ? void 0 : win.webkit) === null || _a === void 0 ? void 0 : _a.messageHandlers) === null || _b === void 0 ? void 0 : _b.bridge) {
          return "ios";
        } else {
          return "web";
        }
      };
      createCapacitor = (win) => {
        const capCustomPlatform = win.CapacitorCustomPlatform || null;
        const cap = win.Capacitor || {};
        const Plugins = cap.Plugins = cap.Plugins || {};
        const getPlatform = () => {
          return capCustomPlatform !== null ? capCustomPlatform.name : getPlatformId(win);
        };
        const isNativePlatform = () => getPlatform() !== "web";
        const isPluginAvailable = (pluginName) => {
          const plugin = registeredPlugins.get(pluginName);
          if (plugin === null || plugin === void 0 ? void 0 : plugin.platforms.has(getPlatform())) {
            return true;
          }
          if (getPluginHeader(pluginName)) {
            return true;
          }
          return false;
        };
        const getPluginHeader = (pluginName) => {
          var _a;
          return (_a = cap.PluginHeaders) === null || _a === void 0 ? void 0 : _a.find((h) => h.name === pluginName);
        };
        const handleError = (err) => win.console.error(err);
        const registeredPlugins = /* @__PURE__ */ new Map();
        const registerPlugin2 = (pluginName, jsImplementations = {}) => {
          const registeredPlugin = registeredPlugins.get(pluginName);
          if (registeredPlugin) {
            console.warn(`Capacitor plugin "${pluginName}" already registered. Cannot register plugins twice.`);
            return registeredPlugin.proxy;
          }
          const platform = getPlatform();
          const pluginHeader = getPluginHeader(pluginName);
          let jsImplementation;
          const loadPluginImplementation = async () => {
            if (!jsImplementation && platform in jsImplementations) {
              jsImplementation = typeof jsImplementations[platform] === "function" ? jsImplementation = await jsImplementations[platform]() : jsImplementation = jsImplementations[platform];
            } else if (capCustomPlatform !== null && !jsImplementation && "web" in jsImplementations) {
              jsImplementation = typeof jsImplementations["web"] === "function" ? jsImplementation = await jsImplementations["web"]() : jsImplementation = jsImplementations["web"];
            }
            return jsImplementation;
          };
          const createPluginMethod = (impl, prop) => {
            var _a, _b;
            if (pluginHeader) {
              const methodHeader = pluginHeader === null || pluginHeader === void 0 ? void 0 : pluginHeader.methods.find((m) => prop === m.name);
              if (methodHeader) {
                if (methodHeader.rtype === "promise") {
                  return (options) => cap.nativePromise(pluginName, prop.toString(), options);
                } else {
                  return (options, callback) => cap.nativeCallback(pluginName, prop.toString(), options, callback);
                }
              } else if (impl) {
                return (_a = impl[prop]) === null || _a === void 0 ? void 0 : _a.bind(impl);
              }
            } else if (impl) {
              return (_b = impl[prop]) === null || _b === void 0 ? void 0 : _b.bind(impl);
            } else {
              throw new CapacitorException(`"${pluginName}" plugin is not implemented on ${platform}`, ExceptionCode.Unimplemented);
            }
          };
          const createPluginMethodWrapper = (prop) => {
            let remove;
            const wrapper = (...args) => {
              const p = loadPluginImplementation().then((impl) => {
                const fn = createPluginMethod(impl, prop);
                if (fn) {
                  const p2 = fn(...args);
                  remove = p2 === null || p2 === void 0 ? void 0 : p2.remove;
                  return p2;
                } else {
                  throw new CapacitorException(`"${pluginName}.${prop}()" is not implemented on ${platform}`, ExceptionCode.Unimplemented);
                }
              });
              if (prop === "addListener") {
                p.remove = async () => remove();
              }
              return p;
            };
            wrapper.toString = () => `${prop.toString()}() { [capacitor code] }`;
            Object.defineProperty(wrapper, "name", {
              value: prop,
              writable: false,
              configurable: false
            });
            return wrapper;
          };
          const addListener = createPluginMethodWrapper("addListener");
          const removeListener = createPluginMethodWrapper("removeListener");
          const addListenerNative = (eventName, callback) => {
            const call = addListener({ eventName }, callback);
            const remove = async () => {
              const callbackId = await call;
              removeListener({
                eventName,
                callbackId
              }, callback);
            };
            const p = new Promise((resolve) => call.then(() => resolve({ remove })));
            p.remove = async () => {
              console.warn(`Using addListener() without 'await' is deprecated.`);
              await remove();
            };
            return p;
          };
          const proxy = new Proxy({}, {
            get(_, prop) {
              switch (prop) {
                // https://github.com/facebook/react/issues/20030
                case "$$typeof":
                  return void 0;
                case "toJSON":
                  return () => ({});
                case "addListener":
                  return pluginHeader ? addListenerNative : addListener;
                case "removeListener":
                  return removeListener;
                default:
                  return createPluginMethodWrapper(prop);
              }
            }
          });
          Plugins[pluginName] = proxy;
          registeredPlugins.set(pluginName, {
            name: pluginName,
            proxy,
            platforms: /* @__PURE__ */ new Set([...Object.keys(jsImplementations), ...pluginHeader ? [platform] : []])
          });
          return proxy;
        };
        if (!cap.convertFileSrc) {
          cap.convertFileSrc = (filePath) => filePath;
        }
        cap.getPlatform = getPlatform;
        cap.handleError = handleError;
        cap.isNativePlatform = isNativePlatform;
        cap.isPluginAvailable = isPluginAvailable;
        cap.registerPlugin = registerPlugin2;
        cap.Exception = CapacitorException;
        cap.DEBUG = !!cap.DEBUG;
        cap.isLoggingEnabled = !!cap.isLoggingEnabled;
        return cap;
      };
      initCapacitorGlobal = (win) => win.Capacitor = createCapacitor(win);
      Capacitor = /* @__PURE__ */ initCapacitorGlobal(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : {});
      registerPlugin = Capacitor.registerPlugin;
      WebPlugin = class {
        constructor() {
          this.listeners = {};
          this.retainedEventArguments = {};
          this.windowListeners = {};
        }
        addListener(eventName, listenerFunc) {
          let firstListener = false;
          const listeners = this.listeners[eventName];
          if (!listeners) {
            this.listeners[eventName] = [];
            firstListener = true;
          }
          this.listeners[eventName].push(listenerFunc);
          const windowListener = this.windowListeners[eventName];
          if (windowListener && !windowListener.registered) {
            this.addWindowListener(windowListener);
          }
          if (firstListener) {
            this.sendRetainedArgumentsForEvent(eventName);
          }
          const remove = async () => this.removeListener(eventName, listenerFunc);
          const p = Promise.resolve({ remove });
          return p;
        }
        async removeAllListeners() {
          this.listeners = {};
          for (const listener in this.windowListeners) {
            this.removeWindowListener(this.windowListeners[listener]);
          }
          this.windowListeners = {};
        }
        notifyListeners(eventName, data, retainUntilConsumed) {
          const listeners = this.listeners[eventName];
          if (!listeners) {
            if (retainUntilConsumed) {
              let args = this.retainedEventArguments[eventName];
              if (!args) {
                args = [];
              }
              args.push(data);
              this.retainedEventArguments[eventName] = args;
            }
            return;
          }
          listeners.forEach((listener) => listener(data));
        }
        hasListeners(eventName) {
          var _a;
          return !!((_a = this.listeners[eventName]) === null || _a === void 0 ? void 0 : _a.length);
        }
        registerWindowListener(windowEventName, pluginEventName) {
          this.windowListeners[pluginEventName] = {
            registered: false,
            windowEventName,
            pluginEventName,
            handler: (event) => {
              this.notifyListeners(pluginEventName, event);
            }
          };
        }
        unimplemented(msg = "not implemented") {
          return new Capacitor.Exception(msg, ExceptionCode.Unimplemented);
        }
        unavailable(msg = "not available") {
          return new Capacitor.Exception(msg, ExceptionCode.Unavailable);
        }
        async removeListener(eventName, listenerFunc) {
          const listeners = this.listeners[eventName];
          if (!listeners) {
            return;
          }
          const index = listeners.indexOf(listenerFunc);
          if (index !== -1) {
            this.listeners[eventName].splice(index, 1);
          }
          if (!this.listeners[eventName].length) {
            this.removeWindowListener(this.windowListeners[eventName]);
          }
        }
        addWindowListener(handle) {
          window.addEventListener(handle.windowEventName, handle.handler);
          handle.registered = true;
        }
        removeWindowListener(handle) {
          if (!handle) {
            return;
          }
          window.removeEventListener(handle.windowEventName, handle.handler);
          handle.registered = false;
        }
        sendRetainedArgumentsForEvent(eventName) {
          const args = this.retainedEventArguments[eventName];
          if (!args) {
            return;
          }
          delete this.retainedEventArguments[eventName];
          args.forEach((arg) => {
            this.notifyListeners(eventName, arg);
          });
        }
      };
      encode = (str) => encodeURIComponent(str).replace(/%(2[346B]|5E|60|7C)/g, decodeURIComponent).replace(/[()]/g, escape);
      decode = (str) => str.replace(/(%[\dA-F]{2})+/gi, decodeURIComponent);
      CapacitorCookiesPluginWeb = class extends WebPlugin {
        async getCookies() {
          const cookies = document.cookie;
          const cookieMap = {};
          cookies.split(";").forEach((cookie) => {
            if (cookie.length <= 0)
              return;
            let [key, value] = cookie.replace(/=/, "CAP_COOKIE").split("CAP_COOKIE");
            key = decode(key).trim();
            value = decode(value).trim();
            cookieMap[key] = value;
          });
          return cookieMap;
        }
        async setCookie(options) {
          try {
            const encodedKey = encode(options.key);
            const encodedValue = encode(options.value);
            const expires = options.expires ? `; expires=${options.expires.replace("expires=", "")}` : "";
            const path = (options.path || "/").replace("path=", "");
            const domain = options.url != null && options.url.length > 0 ? `domain=${options.url}` : "";
            document.cookie = `${encodedKey}=${encodedValue || ""}${expires}; path=${path}; ${domain};`;
          } catch (error) {
            return Promise.reject(error);
          }
        }
        async deleteCookie(options) {
          try {
            document.cookie = `${options.key}=; Max-Age=0`;
          } catch (error) {
            return Promise.reject(error);
          }
        }
        async clearCookies() {
          try {
            const cookies = document.cookie.split(";") || [];
            for (const cookie of cookies) {
              document.cookie = cookie.replace(/^ +/, "").replace(/=.*/, `=;expires=${(/* @__PURE__ */ new Date()).toUTCString()};path=/`);
            }
          } catch (error) {
            return Promise.reject(error);
          }
        }
        async clearAllCookies() {
          try {
            await this.clearCookies();
          } catch (error) {
            return Promise.reject(error);
          }
        }
      };
      CapacitorCookies = registerPlugin("CapacitorCookies", {
        web: () => new CapacitorCookiesPluginWeb()
      });
      readBlobAsBase64 = async (blob) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const base64String = reader.result;
          resolve(base64String.indexOf(",") >= 0 ? base64String.split(",")[1] : base64String);
        };
        reader.onerror = (error) => reject(error);
        reader.readAsDataURL(blob);
      });
      normalizeHttpHeaders = (headers = {}) => {
        const originalKeys = Object.keys(headers);
        const loweredKeys = Object.keys(headers).map((k) => k.toLocaleLowerCase());
        const normalized = loweredKeys.reduce((acc, key, index) => {
          acc[key] = headers[originalKeys[index]];
          return acc;
        }, {});
        return normalized;
      };
      buildUrlParams = (params, shouldEncode = true) => {
        if (!params)
          return null;
        const output = Object.entries(params).reduce((accumulator, entry) => {
          const [key, value] = entry;
          let encodedValue;
          let item;
          if (Array.isArray(value)) {
            item = "";
            value.forEach((str) => {
              encodedValue = shouldEncode ? encodeURIComponent(str) : str;
              item += `${key}=${encodedValue}&`;
            });
            item.slice(0, -1);
          } else {
            encodedValue = shouldEncode ? encodeURIComponent(value) : value;
            item = `${key}=${encodedValue}`;
          }
          return `${accumulator}&${item}`;
        }, "");
        return output.substr(1);
      };
      buildRequestInit = (options, extra = {}) => {
        const output = Object.assign({ method: options.method || "GET", headers: options.headers }, extra);
        const headers = normalizeHttpHeaders(options.headers);
        const type = headers["content-type"] || "";
        if (typeof options.data === "string") {
          output.body = options.data;
        } else if (type.includes("application/x-www-form-urlencoded")) {
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(options.data || {})) {
            params.set(key, value);
          }
          output.body = params.toString();
        } else if (type.includes("multipart/form-data") || options.data instanceof FormData) {
          const form = new FormData();
          if (options.data instanceof FormData) {
            options.data.forEach((value, key) => {
              form.append(key, value);
            });
          } else {
            for (const key of Object.keys(options.data)) {
              form.append(key, options.data[key]);
            }
          }
          output.body = form;
          const headers2 = new Headers(output.headers);
          headers2.delete("content-type");
          output.headers = headers2;
        } else if (type.includes("application/json") || typeof options.data === "object") {
          output.body = JSON.stringify(options.data);
        }
        return output;
      };
      CapacitorHttpPluginWeb = class extends WebPlugin {
        /**
         * Perform an Http request given a set of options
         * @param options Options to build the HTTP request
         */
        async request(options) {
          const requestInit = buildRequestInit(options, options.webFetchExtra);
          const urlParams = buildUrlParams(options.params, options.shouldEncodeUrlParams);
          const url = urlParams ? `${options.url}?${urlParams}` : options.url;
          const response = await fetch(url, requestInit);
          const contentType = response.headers.get("content-type") || "";
          let { responseType = "text" } = response.ok ? options : {};
          if (contentType.includes("application/json")) {
            responseType = "json";
          }
          let data;
          let blob;
          switch (responseType) {
            case "arraybuffer":
            case "blob":
              blob = await response.blob();
              data = await readBlobAsBase64(blob);
              break;
            case "json":
              data = await response.json();
              break;
            case "document":
            case "text":
            default:
              data = await response.text();
          }
          const headers = {};
          response.headers.forEach((value, key) => {
            headers[key] = value;
          });
          return {
            data,
            headers,
            status: response.status,
            url: response.url
          };
        }
        /**
         * Perform an Http GET request given a set of options
         * @param options Options to build the HTTP request
         */
        async get(options) {
          return this.request(Object.assign(Object.assign({}, options), { method: "GET" }));
        }
        /**
         * Perform an Http POST request given a set of options
         * @param options Options to build the HTTP request
         */
        async post(options) {
          return this.request(Object.assign(Object.assign({}, options), { method: "POST" }));
        }
        /**
         * Perform an Http PUT request given a set of options
         * @param options Options to build the HTTP request
         */
        async put(options) {
          return this.request(Object.assign(Object.assign({}, options), { method: "PUT" }));
        }
        /**
         * Perform an Http PATCH request given a set of options
         * @param options Options to build the HTTP request
         */
        async patch(options) {
          return this.request(Object.assign(Object.assign({}, options), { method: "PATCH" }));
        }
        /**
         * Perform an Http DELETE request given a set of options
         * @param options Options to build the HTTP request
         */
        async delete(options) {
          return this.request(Object.assign(Object.assign({}, options), { method: "DELETE" }));
        }
      };
      CapacitorHttp = registerPlugin("CapacitorHttp", {
        web: () => new CapacitorHttpPluginWeb()
      });
      (function(SystemBarsStyle2) {
        SystemBarsStyle2["Dark"] = "DARK";
        SystemBarsStyle2["Light"] = "LIGHT";
        SystemBarsStyle2["Default"] = "DEFAULT";
      })(SystemBarsStyle || (SystemBarsStyle = {}));
      (function(SystemBarType2) {
        SystemBarType2["StatusBar"] = "StatusBar";
        SystemBarType2["NavigationBar"] = "NavigationBar";
      })(SystemBarType || (SystemBarType = {}));
      SystemBarsPluginWeb = class extends WebPlugin {
        async setStyle() {
          this.unavailable("not available for web");
        }
        async setAnimation() {
          this.unavailable("not available for web");
        }
        async show() {
          this.unavailable("not available for web");
        }
        async hide() {
          this.unavailable("not available for web");
        }
      };
      SystemBars = registerPlugin("SystemBars", {
        web: () => new SystemBarsPluginWeb()
      });
    }
  });

  // node_modules/@capgo/background-geolocation/dist/esm/web.js
  var web_exports = {};
  __export(web_exports, {
    BackgroundGeolocationWeb: () => BackgroundGeolocationWeb
  });
  var BackgroundGeolocationWeb;
  var init_web = __esm({
    "node_modules/@capgo/background-geolocation/dist/esm/web.js"() {
      init_dist();
      BackgroundGeolocationWeb = class _BackgroundGeolocationWeb extends WebPlugin {
        constructor() {
          super(...arguments);
          this.plannedRoute = [];
          this.isOffRoute = true;
          this.distanceThreshold = 50;
          this.geofences = /* @__PURE__ */ new Map();
          this.geofenceHeaders = {};
          this.geofencePayload = {};
          this.notifyOnEntry = true;
          this.notifyOnExit = true;
        }
        async start(options, callback) {
          if (!navigator.geolocation) {
            callback(void 0, {
              name: "GeolocationError",
              message: "Geolocation is not supported by this browser",
              code: "NOT_SUPPORTED"
            });
            return;
          }
          if (this.watchId) {
            callback(void 0, {
              name: "GeolocationError",
              message: "Geolocation already started",
              code: "ALREADY_STARTED"
            });
            return;
          }
          this.watchId = navigator.geolocation.watchPosition((position) => {
            const location = {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy,
              altitude: position.coords.altitude,
              altitudeAccuracy: position.coords.altitudeAccuracy,
              simulated: false,
              bearing: position.coords.heading,
              speed: position.coords.speed,
              time: position.timestamp
            };
            if (this.audio && this.plannedRoute.length > 0) {
              const currentPoint = [position.coords.longitude, position.coords.latitude];
              const offRoute = this.distancePointToRoute(currentPoint) > this.distanceThreshold;
              if (offRoute == true && this.isOffRoute === false) {
                this.audio.play();
              }
              this.isOffRoute = offRoute;
            }
            this.checkGeofences(position.coords.latitude, position.coords.longitude);
            callback(location);
          }, (error) => {
            const callbackError = {
              name: "GeolocationError",
              message: error.message,
              code: error.code.toString()
            };
            callback(void 0, callbackError);
          }, {
            enableHighAccuracy: true,
            timeout: 1e4,
            maximumAge: options.stale ? 3e5 : 0
          });
        }
        async stop() {
          if (this.watchId) {
            navigator.geolocation.clearWatch(this.watchId);
            delete this.watchId;
          }
        }
        async openSettings() {
          console.log("openSettings: Web implementation cannot open native settings");
          window.alert("Please enable location permissions in your browser settings");
        }
        async setPlannedRoute(options) {
          if (!options.soundFile) {
            throw new Error("Sound file is required");
          }
          if (this.audio) {
            this.audio.pause();
            this.audio.src = "";
            this.audio = void 0;
          }
          this.audio = new Audio(options.soundFile);
          this.plannedRoute = options.route || [];
          this.distanceThreshold = options.distance || 50;
        }
        async setupGeofencing(options) {
          var _a, _b, _c, _d;
          if (options.url) {
            new URL(options.url);
          }
          this.geofenceUrl = options.url;
          this.geofenceHeaders = Object.assign({}, (_a = options.headers) !== null && _a !== void 0 ? _a : {});
          this.notifyOnEntry = (_b = options.notifyOnEntry) !== null && _b !== void 0 ? _b : true;
          this.notifyOnExit = (_c = options.notifyOnExit) !== null && _c !== void 0 ? _c : true;
          this.geofencePayload = (_d = options.payload) !== null && _d !== void 0 ? _d : {};
        }
        async updateHeaders(options) {
          var _a;
          this.geofenceHeaders = Object.assign({}, (_a = options.headers) !== null && _a !== void 0 ? _a : {});
        }
        async addGeofence(options) {
          var _a, _b, _c, _d;
          if (!navigator.geolocation) {
            throw new Error("Geolocation is not supported by this browser");
          }
          this.validateGeofence(options.latitude, options.longitude, (_a = options.radius) !== null && _a !== void 0 ? _a : 50, options.identifier);
          this.geofences.set(options.identifier, {
            latitude: options.latitude,
            longitude: options.longitude,
            radius: (_b = options.radius) !== null && _b !== void 0 ? _b : 50,
            identifier: options.identifier,
            notifyOnEntry: (_c = options.notifyOnEntry) !== null && _c !== void 0 ? _c : this.notifyOnEntry,
            notifyOnExit: (_d = options.notifyOnExit) !== null && _d !== void 0 ? _d : this.notifyOnExit,
            payload: options.payload
          });
          this.startGeofenceWatch();
        }
        async removeGeofence(options) {
          if (!options.identifier) {
            throw new Error("Identifier is required");
          }
          this.geofences.delete(options.identifier);
          this.stopGeofenceWatchIfIdle();
        }
        async removeAllGeofences() {
          this.geofences.clear();
          this.stopGeofenceWatchIfIdle();
        }
        async getMonitoredGeofences() {
          return { regions: Array.from(this.geofences.keys()) };
        }
        async checkPermissions() {
          if (!navigator.permissions) {
            return {
              location: "prompt",
              backgroundLocation: "prompt",
              notification: "granted"
            };
          }
          try {
            const status = await navigator.permissions.query({ name: "geolocation" });
            const location = status.state === "granted" ? "granted" : status.state === "denied" ? "denied" : "prompt";
            return {
              location,
              backgroundLocation: location,
              notification: "granted"
            };
          } catch (_a) {
            return {
              location: "prompt",
              backgroundLocation: "prompt",
              notification: "granted"
            };
          }
        }
        async requestPermissions() {
          return this.checkPermissions();
        }
        validateGeofence(latitude, longitude, radius, identifier) {
          if (!identifier) {
            throw new Error("Identifier is required");
          }
          if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
            throw new Error("Latitude must be between -90 and 90");
          }
          if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
            throw new Error("Longitude must be between -180 and 180");
          }
          if (!Number.isFinite(radius) || radius <= 0) {
            throw new Error("Radius must be greater than 0");
          }
        }
        startGeofenceWatch() {
          if (this.geofenceWatchId !== void 0 || this.geofences.size === 0 || !navigator.geolocation) {
            return;
          }
          this.geofenceWatchId = navigator.geolocation.watchPosition((position) => this.checkGeofences(position.coords.latitude, position.coords.longitude), () => void 0, {
            enableHighAccuracy: false,
            timeout: 3e4,
            maximumAge: 6e4
          });
        }
        stopGeofenceWatchIfIdle() {
          if (this.geofences.size > 0 || this.geofenceWatchId === void 0) {
            return;
          }
          navigator.geolocation.clearWatch(this.geofenceWatchId);
          this.geofenceWatchId = void 0;
        }
        checkGeofences(latitude, longitude) {
          const point = [longitude, latitude];
          this.geofences.forEach((geofence) => {
            const distance = this.haversine(point, [geofence.longitude, geofence.latitude]);
            const inside = distance <= geofence.radius;
            const previousInside = geofence.inside;
            geofence.inside = inside;
            if (inside && previousInside !== true && geofence.notifyOnEntry) {
              this.emitGeofenceTransition(geofence, true);
            } else if (!inside && previousInside === true && geofence.notifyOnExit) {
              this.emitGeofenceTransition(geofence, false);
            }
          });
        }
        emitGeofenceTransition(geofence, enter) {
          var _a;
          const payload = Object.assign(Object.assign({}, this.geofencePayload), (_a = geofence.payload) !== null && _a !== void 0 ? _a : {});
          const event = Object.assign(Object.assign({}, payload), { identifier: geofence.identifier, transition: enter ? "enter" : "exit", enter, latitude: geofence.latitude, longitude: geofence.longitude, radius: geofence.radius, payload });
          void this.notifyListeners("geofenceTransition", event);
          if (this.geofenceUrl) {
            void fetch(this.geofenceUrl, {
              method: "POST",
              headers: Object.assign({ Accept: "application/json", "Content-Type": "application/json" }, this.geofenceHeaders),
              body: JSON.stringify(event)
            }).catch(() => void 0);
          }
        }
        toRadians(degrees) {
          return degrees * Math.PI / 180;
        }
        haversine(point1, point2) {
          const [lon1, lat1] = point1;
          const [lon2, lat2] = point2;
          const dLat = this.toRadians(lat2 - lat1);
          const dLon = this.toRadians(lon2 - lon1);
          const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          return _BackgroundGeolocationWeb.EARTH_RADIUS_M * c;
        }
        distancePointToLineSegment(point, lineStart, lineEnd) {
          const dist_A_B = this.haversine(point, lineStart);
          const dist_A_C = this.haversine(point, lineEnd);
          const dist_B_C = this.haversine(lineStart, lineEnd);
          if (dist_B_C === 0) {
            return dist_A_B;
          }
          const cos_B = (dist_A_B ** 2 + dist_B_C ** 2 - dist_A_C ** 2) / (2 * dist_A_B * dist_B_C + Number.EPSILON);
          if (cos_B < 0) {
            return dist_A_B;
          }
          const cos_C = (dist_A_C ** 2 + dist_B_C ** 2 - dist_A_B ** 2) / (2 * dist_A_C * dist_B_C + Number.EPSILON);
          if (cos_C < 0) {
            return dist_A_C;
          }
          const s = (dist_A_B + dist_A_C + dist_B_C) / 2;
          const area = Math.sqrt(Math.max(0, s * (s - dist_A_B) * (s - dist_A_C) * (s - dist_B_C)));
          return 2 * area / (dist_B_C + Number.EPSILON);
        }
        distancePointToRoute(point) {
          if (this.plannedRoute.length < 2) {
            if (this.plannedRoute.length === 1) {
              return this.haversine(point, this.plannedRoute[0]);
            }
            return Infinity;
          }
          let minDistance = Infinity;
          for (let i = 0; i < this.plannedRoute.length - 1; i++) {
            const lineStart = this.plannedRoute[i];
            const lineEnd = this.plannedRoute[i + 1];
            const distance = this.distancePointToLineSegment(point, lineStart, lineEnd);
            if (distance < minDistance) {
              minDistance = distance;
            }
          }
          return minDistance;
        }
        async getPluginVersion() {
          return { version: "web" };
        }
      };
      BackgroundGeolocationWeb.EARTH_RADIUS_M = 6371e3;
    }
  });

  // node_modules/@capgo/background-geolocation/dist/esm/index.js
  init_dist();
  var BackgroundGeolocation = registerPlugin("BackgroundGeolocation", {
    web: () => Promise.resolve().then(() => (init_web(), web_exports)).then((m) => new m.BackgroundGeolocationWeb())
  });

  // src/native-geo.ts
  var callbacks = /* @__PURE__ */ new Map();
  var nextWatcherId = 0;
  var nativeWatcherStarted = false;
  var operationQueue = Promise.resolve();
  function serialize(operation) {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(
      () => void 0,
      () => void 0
    );
    return result;
  }
  function finiteOrNull(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  function toNativeError(error) {
    if (typeof error === "object" && error !== null) {
      const candidate = error;
      return {
        code: typeof candidate.code === "string" && candidate.code ? candidate.code : "LOCATION_ERROR",
        message: typeof candidate.message === "string" && candidate.message ? candidate.message : "Location tracking failed."
      };
    }
    return {
      code: "LOCATION_ERROR",
      message: error instanceof Error ? error.message : String(error)
    };
  }
  function notifyAll(location, error) {
    for (const callback of callbacks.values()) {
      callback(location, error);
    }
  }
  function onNativeLocation(location, error) {
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
        time: finiteOrNull(location.time) ?? Date.now()
      },
      null
    );
  }
  var ItlesNative = {
    platform: "android",
    version: "0.3.5",
    async addWatcher(opts, callback) {
      const id = `itles-${Date.now().toString(36)}-${(++nextWatcherId).toString(36)}`;
      callbacks.set(id, callback);
      try {
        await serialize(async () => {
          if (!callbacks.has(id) || nativeWatcherStarted) return;
          const permissionStatus = await BackgroundGeolocation.requestPermissions({
            permissions: ["location", "notification"]
          });
          if (permissionStatus.location !== "granted") {
            throw new Error("Location permission was not granted.");
          }
          await BackgroundGeolocation.start(
            {
              backgroundTitle: opts.backgroundTitle,
              backgroundMessage: opts.backgroundMessage,
              distanceFilter: opts.distanceFilter,
              requestPermissions: true,
              stale: false
            },
            onNativeLocation
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
    async removeWatcher(id) {
      callbacks.delete(id);
      await serialize(async () => {
        if (callbacks.size > 0 || !nativeWatcherStarted) return;
        await BackgroundGeolocation.stop();
        nativeWatcherStarted = false;
      });
    },
    openSettings: () => BackgroundGeolocation.openSettings()
  };
  window.ItlesNative = ItlesNative;
})();
/*! Bundled license information:

@capacitor/core/dist/index.js:
  (*! Capacitor: https://capacitorjs.com/ - MIT License *)
*/
