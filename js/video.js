// YouTube の URL を読み取り、確かめた ID と秒だけから URL を組み立てる。
import { CONFIG } from './config.js';

export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtube-nocookie.com']);

const validId = (id) => typeof id === 'string' && id.length === 11 && VIDEO_ID_PATTERN.test(id);

export function normalizeVideoStart(start) {
  return Number.isInteger(start) && start >= 0 && start <= CONFIG.video.maxStart ? start : 0;
}

function parseStart(text) {
  if (!text || /\s/.test(text)) return 0;
  if (/^\d+$/.test(text)) return normalizeVideoStart(Number(text));
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (!match) return 0;
  return normalizeVideoStart(Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0));
}

export function parseYouTubeUrl(text) {
  if (typeof text !== 'string') return null;
  const input = text.trim();
  if (!input || /[\s\\]/.test(input)) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`);
  } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || !HOSTS.has(url.hostname)
    || url.username || url.password || url.port) return null;
  let videoId;
  if (url.hostname === 'youtu.be') {
    videoId = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  } else if (url.pathname === '/watch') {
    videoId = url.searchParams.get('v');
  } else {
    videoId = /^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  }
  if (!validId(videoId)) return null;
  return { videoId, start: parseStart(url.searchParams.get('t') ?? url.searchParams.get('start')) };
}

export function youTubeEmbedUrl({ videoId, start } = {}) {
  if (!validId(videoId)) return null;
  const seconds = normalizeVideoStart(start);
  return `https://www.youtube-nocookie.com/embed/${videoId}?rel=0&playsinline=1${seconds > 0 ? `&start=${seconds}` : ''}`;
}

export function youTubeWatchUrl({ videoId, start } = {}) {
  if (!validId(videoId)) return '';
  const seconds = normalizeVideoStart(start);
  return `https://youtu.be/${videoId}${seconds > 0 ? `?t=${seconds}` : ''}`;
}

// 始める位置を、入力欄の下で読める文にする。
export function formatVideoStart(start) {
  const seconds = normalizeVideoStart(start);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const rest = seconds % 60;
  return [hours ? `${hours} 時間` : '', minutes ? `${minutes} 分` : '', rest || !seconds ? `${rest} 秒` : ''].filter(Boolean).join(' ');
}
