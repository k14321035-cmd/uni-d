/**
 * API client helper.
 *
 * On a browser the page is served from the same Express host, so relative
 * paths like "/api/..." work fine.
 *
 * Inside the Capacitor Android WebView the page origin is "file://" (or
 * "https://localhost" depending on config), so relative paths break.
 * We detect Capacitor and prefix every request with the absolute server URL
 * configured via the VITE_APP_URL environment variable.
 *
 * Set VITE_APP_URL in your .env to your server's LAN IP, e.g.:
 *   VITE_APP_URL=http://192.168.1.100:3000
 */

/** True when the app is running inside a Capacitor (native) WebView */
const isCapacitor =
  typeof (window as any).Capacitor !== 'undefined' &&
  (window as any).Capacitor?.isNativePlatform?.() === true;

/**
 * The base URL to prepend to every API call.
 * - In a browser:  '' (empty string, so paths stay relative)
 * - In Capacitor:  the value of import.meta.env.VITE_APP_URL, stripped of
 *                  trailing slashes (e.g. "http://192.168.1.100:3000")
 */
const BASE_URL: string = (() => {
  if (!isCapacitor) return '';
  const envUrl: string = (import.meta.env.VITE_APP_URL as string) || '';
  return envUrl.replace(/\/+$/, '');
})();

/**
 * Build an absolute URL for an API path.
 *
 * @example
 * apiUrl('/api/video-info')
 * // Browser  → '/api/video-info'
 * // Android  → 'http://192.168.1.100:3000/api/video-info'
 */
export function apiUrl(path: string): string {
  // Ensure path starts with /
  const normalised = path.startsWith('/') ? path : `/${path}`;
  
  const urlParams = new URLSearchParams(window.location.search);
  const platform = urlParams.get('platform');
  const version = urlParams.get('version');

  let fullUrl = `${BASE_URL}${normalised}`;
  
  if (platform || version) {
    const parts = fullUrl.split('?');
    const basePath = parts[0];
    const queryParams = new URLSearchParams(parts[1] || '');
    
    if (platform) queryParams.set('platform', platform);
    if (version) queryParams.set('version', version);
    
    fullUrl = `${basePath}?${queryParams.toString()}`;
  }
  
  return fullUrl;
}

/**
 * Drop-in replacement for EventSource that uses the correct base URL.
 *
 * @example
 * const es = nativeEventSource(`/api/prepare-stream?url=...`);
 */
export function nativeEventSource(path: string): EventSource {
  return new EventSource(apiUrl(path));
}
