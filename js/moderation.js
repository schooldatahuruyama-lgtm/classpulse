// 不適切な言葉の照らし合わせ。通信・画面に触れない。
import { CONFIG } from './config.js';

export const BUILTIN_WORDS = [
  '死ね', '氏ね', 'タヒね', 'しねよ', '殺す', '殺してや', '殺したい', 'ぶっ殺', 'ころすぞ', 'コロス', '消えろ', 'きえろ', 'くたばれ',
  'うざい', 'ウザい', 'ウザイ', 'うぜえ', 'うぜー', 'きもい', 'キモい', 'キモイ', 'きしょい', 'キショい', 'キショイ',
  'バカ', '馬鹿', 'アホ', '阿呆', 'クソ', '糞', 'クズ', 'デブ', 'ブス', 'ハゲ', 'ガイジ', 'キチガイ', '気違い',
  '黙れ', 'だまれ', 'うるせえ', 'うるせー', 'ふざけんな', 'てめえ', 'てめー',
  'うんこ', 'ウンコ', 'ちんちん', 'チンチン', 'まんこ', 'マンコ', 'おっぱい', 'オッパイ', 'セックス', 'fuck', 'shit', 'bitch',
];

export function normalizeForCheck(text) {
  return typeof text === 'string' ? text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '') : '';
}

export function normalizeWordList(raw) {
  if (!Array.isArray(raw)) return [];
  const words = [];
  const seen = new Set();
  for (const value of raw) {
    if (words.length >= CONFIG.moderation.maxWords) break;
    if (typeof value !== 'string') continue;
    const word = value.trim();
    const key = normalizeForCheck(word);
    if (word.length > CONFIG.moderation.maxWordLength || key.length < CONFIG.moderation.minCheckLength || seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  return words;
}

export function normalizeModeration(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || typeof raw.enabled !== 'boolean' || (raw.words !== undefined && !Array.isArray(raw.words))) {
    return { enabled: true, words: [] };
  }
  // データベースは空の配列を省くため、words が無い場合も受けつける。
  return { enabled: raw.enabled, words: normalizeWordList(raw.words) };
}

export function createChecker(settings) {
  const { enabled, words } = normalizeModeration(settings);
  const keys = [...new Set([...BUILTIN_WORDS, ...words].map(normalizeForCheck))];
  return (text) => {
    if (!enabled || typeof text !== 'string') return false;
    const normalized = normalizeForCheck(text);
    return keys.some((key) => normalized.includes(key));
  };
}
