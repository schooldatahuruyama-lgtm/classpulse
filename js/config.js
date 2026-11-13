// アプリ全体で使う定数
export const CONFIG = {
  image: { maxEdge: 1280, maxBytes: 204800, deckMaxBytes: 5242880 },
  pdf: { maxPages: 30, maxFileBytes: 52428800 },
  pptx: {
    maxSlides: 100, maxFileBytes: 52428800, maxEntries: 5000,
    maxXmlBytes: 5242880, maxImageBytes: 31457280, maxTotalBytes: 209715200,
    maxXmlDepth: 200, maxTextLength: 2000,
  },
  autosaveDelayMs: 1000,
  autosaveRetryMs: 5000,
  autosaveMaxWaitMs: 5000,
  resultsThrottleMs: 500,
  poll: { minOptions: 2, maxOptions: 6 },
  free: { maxLength: 200 },
  moderation: { maxWords: 100, maxWordLength: 20, minCheckLength: 2 },
  // ワードクラウド: 1 人の言葉の数、1 つの言葉の長さ、発表画面に出す言葉の数
  cloud: { maxWords: 3, maxLength: 20, maxShown: 60 },
  // 5 段階評価: 段階の数、両はしの言葉の長さ
  rating: { steps: 5, labelMaxLength: 20 },
  video: { captionMaxLength: 100, maxStart: 86400 },
  // 図形: 選べる色（名前と色。css/base.css の配色に白・黒・灰色を足したもの）。
  // stroke: true の色だけを線の色に使える（白い背景との差が 3:1 以上。見えにくい線を作らない）。
  // 線の太さは、スライドの幅に対する %
  shape: {
    colors: [
      { name: 'あお', value: '#3F63F6', stroke: true },
      { name: 'こん', value: '#1F2A6B', stroke: true },
      { name: 'みずいろ', value: '#45D0C2', stroke: true },
      { name: 'みどり', value: '#52C97A', stroke: true },
      { name: 'きいろ', value: '#F4C94A', stroke: true },
      { name: 'あか', value: '#E8576A', stroke: true },
      { name: 'むらさき', value: '#A88CF6', stroke: true },
      { name: 'しろ', value: '#FFFFFF', stroke: true },
      { name: 'くろ', value: '#000000', stroke: true },
      { name: 'はいいろ', value: '#767676', stroke: true },
    ],
    defaultFill: '#45D0C2',
    defaultStroke: '#1F2A6B',
    widths: { s: 0.3, m: 0.6, l: 1.2 },
  },
  // ゴミ箱: 教材を残す日数
  trash: { keepDays: 30 },
  idLength: 12,
  sessionIdLength: 22,
  tokenRefreshMarginMs: 300000,
  googleLogin: { maxAgeMs: 600000, storageKey: 'classpulse:google-login' },
  driveExport: { maxAgeMs: 600000, storageKey: 'classpulse:drive-export', scope: 'https://www.googleapis.com/auth/drive.file', tokenMarginMs: 60000 },
  reconnectDelayMs: 3000,
  streamStallMs: 75000,
  streamWakeMs: 10000,
  joinRetry: { delaysMs: [2000, 4000, 8000], jitterMs: 1000 },
};
