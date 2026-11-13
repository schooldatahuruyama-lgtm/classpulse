import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTubeUrl, youTubeEmbedUrl, youTubeWatchUrl, VIDEO_ID_PATTERN, formatVideoStart } from '../js/video.js';
import { CONFIG } from '../js/config.js';

const ID = 'AbCdEf01_-2';

test('動画: 設定の上限と ID の形', () => {
  assert.deepEqual(CONFIG.video, { captionMaxLength: 100, maxStart: 86400 });
  assert.equal(VIDEO_ID_PATTERN.source, '^[A-Za-z0-9_-]{11}$');
});

for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'www.youtube-nocookie.com']) {
  test(`動画 URL: ${host} の watch・embed・shorts・live、スキームなし・大文字`, () => {
    for (const path of [`watch?v=${ID}`, `embed/${ID}`, `shorts/${ID}`, `live/${ID}`]) {
      for (const prefix of ['https://', 'http://', '']) {
        assert.deepEqual(parseYouTubeUrl(`  ${prefix}${host.toUpperCase()}/${path}  `), { videoId: ID, start: 0 });
      }
    }
  });
}

test('動画 URL: 短い URL、共有用の余計な値、末尾の / を読める', () => {
  for (const input of [`https://youtu.be/${ID}`, `youtu.be/${ID}/?si=share&list=sample#ignored`, `https://youtube.com/embed/${ID}/`]) {
    assert.deepEqual(parseYouTubeUrl(input), { videoId: ID, start: 0 });
  }
});

test('動画 URL: 似たホスト・別スキーム・動画でないパス・不正な ID を拒否する', () => {
  const bad = [null, undefined, 123, {}, '', ID,
    ...['youtube.com.example.org', 'notyoutube.com', 'youtu.be.evil.jp', 'www.youtu.be', 'youtube-nocookie.com', 'example.org']
      .map((host) => `https://${host}/watch?v=${ID}`),
    `javascript:https://youtube.com/watch?v=${ID}`, `data:text/html,${ID}`, `ftp://youtube.com/watch?v=${ID}`,
    `https://youtube.com@evil.jp/watch?v=${ID}`, `https://user:pass@youtube.com/watch?v=${ID}`, `https://youtube.com:444/watch?v=${ID}`,
    'https://youtube.com/playlist?list=sample', `https://youtube.com/channel/${ID}`, `https://youtube.com/@${ID}`,
    'https://youtube.com/watch', `https://youtube.com/watch/${ID}`, `https://youtu.be/${ID}/extra`,
    `https://youtube.com/embed/${ID}/extra`, `https://you\ntube.com/watch?v=${ID}`, `https://youtube.com\\evil.jp/watch?v=${ID}`,
    ...['short', ID + 'x', '><script>xx', '../x', 'AbCdEf01_.2', 'あ'.repeat(11), ID + '\n'].flatMap((id) => [
      `https://youtube.com/watch?v=${encodeURIComponent(id)}`, `https://youtu.be/${encodeURIComponent(id)}`,
    ]),
  ];
  for (const input of bad) assert.equal(parseYouTubeUrl(input), null, String(input));
});

test('動画 URL: 開始位置を秒にする。t があれば start より優先する', () => {
  const cases = [['90', 90], ['90s', 90], ['1m30s', 90], ['1h2m3s', 3723], ['1m', 60], ['24h', 86400], ['86400', 86400],
    ['0', 0], ['86401', 0], ['24h1s', 0], ['-1', 0], ['1.5', 0], ['1:30', 0], ['wrong', 0], ['1m30', 0], ['1s2m', 0], ['90%0A', 0], ['%2090', 0], ['', 0], ['9'.repeat(400), 0]];
  for (const [value, start] of cases) {
    for (const key of ['t', 'start']) assert.deepEqual(parseYouTubeUrl(`https://youtu.be/${ID}?${key}=${value}`), { videoId: ID, start });
  }
  assert.equal(parseYouTubeUrl(`https://youtu.be/${ID}?t=90&start=60`).start, 90);
});

test('動画 URL: 決まった URL だけを組み立て、再度 ID・秒を確かめる', () => {
  const embed = `https://www.youtube-nocookie.com/embed/${ID}?rel=0&playsinline=1`;
  assert.equal(youTubeEmbedUrl({ videoId: ID, start: 90 }), `${embed}&start=90`);
  assert.equal(youTubeWatchUrl({ videoId: ID, start: 90 }), `https://youtu.be/${ID}?t=90`);
  for (const start of [undefined, 0, -1, 86401, 1.5, '90', NaN, Infinity, '90&autoplay=1']) {
    assert.equal(youTubeEmbedUrl({ videoId: ID, start }), embed);
    assert.equal(youTubeWatchUrl({ videoId: ID, start }), `https://youtu.be/${ID}`);
  }
  assert.equal(youTubeEmbedUrl({ videoId: ID, start: 86400 }), `${embed}&start=86400`);
  for (const videoId of ['', '"><script>', '../x', 12345678901, 'x'.repeat(12), ID + '\n', null, undefined, { toString: () => ID }]) {
    assert.equal(youTubeEmbedUrl({ videoId }), null);
    assert.equal(youTubeWatchUrl({ videoId }), '');
  }
  assert.equal(youTubeEmbedUrl(), null);
  assert.deepEqual(parseYouTubeUrl(youTubeWatchUrl({ videoId: ID, start: 90 })), { videoId: ID, start: 90 });
});

test('動画: 開始位置を時間・分・秒で表示する', () => {
  for (const [start, text] of [[0, '0 秒'], [3, '3 秒'], [60, '1 分'], [90, '1 分 30 秒'], [3600, '1 時間'], [3723, '1 時間 2 分 3 秒'], [86400, '24 時間'], [-1, '0 秒']]) {
    assert.equal(formatVideoStart(start), text);
  }
});
