// アプリ全体で使う定数
export const CONFIG = {
  image: { maxEdge: 1280, maxBytes: 204800, deckMaxBytes: 5242880 },
  pdf: { maxPages: 30, maxFileBytes: 52428800 },
  autosaveDelayMs: 1000,
  autosaveRetryMs: 5000,
  autosaveMaxWaitMs: 5000,
  resultsThrottleMs: 500,
  poll: { minOptions: 2, maxOptions: 6 },
  free: { maxLength: 200 },
  // ワードクラウド: 1 人の言葉の数、1 つの言葉の長さ、発表画面に出す言葉の数
  cloud: { maxWords: 3, maxLength: 20, maxShown: 60 },
  idLength: 12,
  sessionIdLength: 22,
  tokenRefreshMarginMs: 300000,
  reconnectDelayMs: 3000,
};
