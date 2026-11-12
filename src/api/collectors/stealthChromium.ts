type LaunchOptions = NonNullable<
  Parameters<import("playwright").BrowserType["launch"]>[0]
>;
type ProxyOption = NonNullable<LaunchOptions["proxy"]>;

/**
 * Reads `BROWSER_PROXY_URL` (`http://host:port`, `socks5://host:port`, with
 * optional `user:pass@`) into Playwright's `proxy` launch option. Unset or
 * malformed: no proxy.
 */
export function browserProxyFromEnv(
  value = process.env.BROWSER_PROXY_URL,
): ProxyOption | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const proxy: ProxyOption = { server: `${url.protocol}//${url.host}` };
    if (url.username) proxy.username = decodeURIComponent(url.username);
    if (url.password) proxy.password = decodeURIComponent(url.password);
    return proxy;
  } catch {
    return undefined;
  }
}

let stealthChromium: Promise<import("playwright").BrowserType> | undefined;

/**
 * Chromium from `playwright-extra` with the stealth plugin. Dynamic imports
 * only: Workers rejects a bundle with a static top-level `playwright` import.
 */
export function getStealthChromium(): Promise<
  import("playwright").BrowserType
> {
  stealthChromium ??= (async () => {
    const { chromium } = await import("playwright-extra");
    const { default: StealthPlugin } =
      await import("puppeteer-extra-plugin-stealth");
    chromium.use(StealthPlugin());
    return chromium as unknown as import("playwright").BrowserType;
  })();
  return stealthChromium;
}

/**
 * Proxy of the Dealabs window only (`DEALABS_PROXY_URL`, else
 * `BROWSER_PROXY_URL`): lets Dealabs see another address than the server's
 * while the shop collectors keep their direct connection.
 */
export function dealabsProxyFromEnv(): ProxyOption | undefined {
  return (
    browserProxyFromEnv(process.env.DEALABS_PROXY_URL) ?? browserProxyFromEnv()
  );
}

/** Launch options plus the optional proxy from the environment. */
export function withProxy(
  options: LaunchOptions = {},
  proxy = browserProxyFromEnv(),
): LaunchOptions {
  return proxy ? { ...options, proxy } : options;
}
