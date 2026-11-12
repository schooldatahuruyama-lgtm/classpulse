// アプリ全体で使う定数
export const CONFIG = {
  image: { maxEdge: 1280, maxBytes: 204800, deckMaxBytes: 5242880 },
  autosaveDelayMs: 1000,
  autosaveRetryMs: 5000,
  autosaveMaxWaitMs: 5000,
  resultsThrottleMs: 500,
  poll: { minOptions: 2, maxOptions: 6 },
  free: { maxLength: 200 },
  idLength: 12,
  sessionIdLength: 22,
  tokenRefreshMarginMs: 300000,
  reconnectDelayMs: 3000,
};
