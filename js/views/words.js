// 先生の「止める言葉」。離れた画面には読みこみ・保存の結果を出さない。
import { el } from '../ui.js';
import { BUILTIN_WORDS, normalizeForCheck, normalizeWordList, normalizeModeration } from '../moderation.js';

export function wordsInput(text) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const valid = lines.filter((line) => normalizeWordList([line]).length > 0);
  const unique = new Set(valid.map(normalizeForCheck));
  const words = normalizeWordList(valid);
  return { words, removed: lines.length - valid.length + unique.size - words.length };
}

export function mount(root, ctx) {
  let alive = true;
  let busy = false;
  const content = el('div');
  root.replaceChildren(el('div', { class: 'page-pad words-page' },
    el('h1', { text: '止める言葉' }),
    el('p', { text: '自由記述とワードクラウドで、下の言葉が入った回答は、教室の画面に出さずに止めます。止めた回答は、授業中に確かめて映すことも、授業のあとに結果の画面で読むこともできます。' }),
    el('p', { text: '自動チェックは、すべての不適切な回答を見つけられるわけではありません。' }), content));

  function form(settings) {
    const enabled = el('input', { type: 'checkbox', checked: settings.enabled });
    const words = el('textarea', { id: 'words-extra', rows: 10, value: settings.words.join('\n') });
    const message = el('div', { role: 'status', class: 'words-message' });
    const save = el('button', { type: 'submit', class: 'btn btn-primary', text: '保存' });
    const setBusy = (value) => { busy = value; enabled.disabled = value; words.disabled = value; save.disabled = value; };
    const node = el('form', { class: 'words-form', onsubmit: async (ev) => {
      ev.preventDefault();
      if (!alive || busy) return;
      const input = wordsInput(words.value);
      setBusy(true);
      message.replaceChildren();
      try {
        await ctx.repo.saveModeration({ enabled: enabled.checked, words: input.words });
        if (!alive) return;
        words.value = input.words.join('\n');
        message.append(el('p', { text: '保存しました。次に発表の画面を開いたときから使われます。' }));
        if (input.removed) message.append(el('p', { text: `使えない言葉を ${input.removed} 個はずしました。` }));
      } catch {
        if (alive) message.append(el('p', { role: 'alert', text: '保存できませんでした。接続を確かめて、もう一度押してください。' }));
      } finally {
        if (alive) setBusy(false);
      }
    } },
    el('label', { class: 'words-enabled' }, enabled, '不適切な言葉の自動チェックを使う'),
    el('label', { for: 'words-extra', text: '足す言葉（1 行に 1 つ）' }), words,
    el('details', {}, el('summary', { text: 'はじめから入っている言葉を見る' }),
      el('p', { class: 'words-builtin', text: BUILTIN_WORDS.join('　') })), save, message);
    content.replaceChildren(node);
  }

  async function load() {
    if (!alive || busy) return;
    busy = true;
    content.replaceChildren(el('p', { role: 'status', text: '読みこんでいます…' }));
    try {
      const settings = await ctx.repo.getModeration();
      if (alive) form(normalizeModeration(settings));
    } catch {
      if (alive) content.replaceChildren(el('p', { role: 'alert', text: '読みこめませんでした。' }),
        el('button', { type: 'button', class: 'btn', text: 'もう一度', onclick: load }));
    } finally {
      if (alive) busy = false;
    }
  }

  load();
  return () => { alive = false; };
}
