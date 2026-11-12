// スライド編集: 右の列（選んだ要素の設定）と、アンケートの入力欄・設定
import { el } from '../../ui.js';
import { TEXT_COLORS, OPTION_MARKS } from '../../slide-render.js';
import { CONFIG } from '../../config.js';

const SIZES = [
  { value: 's', label: '小' },
  { value: 'm', label: '中' },
  { value: 'l', label: '大' },
  { value: 'xl', label: '特大' },
];
const ALIGNS = [
  { value: 'left', label: '左' },
  { value: 'center', label: '中央' },
  { value: 'right', label: '右' },
];

export const POLL_NOTE = 'このアンケートは匿名です。次のスライドへ進むと締め切ります。締め切る前は、生徒は答えを変えられます。';

export const FREE_NOTE = '生徒は文章で答えます。次のスライドへ進むと締め切ります。';

// 押した状態を持つボタンの組（aria-pressed と「✓」の文字で、色だけに頼らない）
function choiceGroup(id, label, choices, current, onPick, { swatch = false } = {}) {
  return el('div', { class: 'ed-group', role: 'group', 'aria-labelledby': id },
    el('p', { id, class: 'ed-side-label', text: label }),
    el('div', { class: swatch ? 'ed-choices ed-choices-color' : 'ed-choices' },
      choices.map((c) => {
        const on = c.value === current;
        return el('button', {
          type: 'button', class: on ? 'btn ed-choice is-on' : 'btn ed-choice',
          'aria-pressed': on ? 'true' : 'false', dataset: { focusKey: `${id}:${c.value}` },
          onclick: () => onPick(c.value),
        },
        swatch ? el('span', { class: 'ed-swatch', 'aria-hidden': 'true', style: `background:${c.value}` }) : null,
        el('span', { text: c.label }),
        on ? el('span', { class: 'ed-check', 'aria-hidden': 'true', text: '✓' }) : null);
      })));
}

function deleteItemButton(ed, item) {
  return el('button', { type: 'button', class: 'btn btn-danger ed-wide', text: 'この要素を削除', onclick: () => ed.removeItem(item.id) });
}

// 資料スライドの右の列
export function renderItemInspector(host, ed) {
  const id = ed.state.itemId;
  const item = id ? (ed.currentSlide()?.items || []).find((it) => it.id === id) : null;
  if (!item) {
    host.replaceChildren(
      el('h2', { class: 'ed-col-title', text: '設定' }),
      el('p', { class: 'muted', text: 'キャンバスの要素をタップすると、ここで設定できます。' }));
    return;
  }
  if (item.kind === 'image') {
    host.replaceChildren(
      el('h2', { class: 'ed-col-title', text: '画像の設定' }),
      deleteItemButton(ed, item));
    return;
  }
  // 入力中に文字が変わっていることがあるので、いつも最新の要素に重ねる
  const set = (patch) => {
    const cur = (ed.currentSlide()?.items || []).find((it) => it.id === id);
    if (cur) ed.updateItem({ ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) }, { refresh: true, side: true });
  };
  const color = String(item.color || '').toUpperCase();
  host.replaceChildren(
    el('h2', { class: 'ed-col-title', text: '文字の設定' }),
    choiceGroup('ed-size', '大きさ', SIZES, item.size, (v) => set({ size: v })),
    el('div', { class: 'ed-group' },
      el('button', {
        type: 'button', class: item.bold ? 'btn ed-choice is-on' : 'btn ed-choice', dataset: { focusKey: 'ed-bold' },
        'aria-pressed': item.bold ? 'true' : 'false', onclick: () => set((cur) => ({ bold: !cur.bold })),
      }, el('span', { class: 'ed-bold-mark', text: '太字' }), item.bold ? el('span', { class: 'ed-check', 'aria-hidden': 'true', text: '✓' }) : null)),
    choiceGroup('ed-color', '色', TEXT_COLORS, color, (v) => set({ color: v }), { swatch: true }),
    choiceGroup('ed-align', 'そろえ', ALIGNS, item.align, (v) => set({ align: v })),
    deleteItemButton(ed, item));
}

// アンケートの右の列（結果の出し方と説明）
export function renderPollSettings(host, ed) {
  const slide = ed.currentSlide();
  const radio = (value, label) => el('label', { class: 'ed-radio' },
    el('input', {
      type: 'radio', name: 'ed-result-mode', value, checked: slide.resultMode === value,
      'aria-labelledby': `ed-result-mode-${value}`, // 読み上げの名前は日本語の文（値の manual / live ではなく）
      onchange: () => ed.patchSlide({ resultMode: value }),
    }),
    el('span', { id: `ed-result-mode-${value}`, text: label }));
  host.replaceChildren(
    el('h2', { class: 'ed-col-title', text: 'アンケートの設定' }),
    el('fieldset', { class: 'ed-fieldset' },
      el('legend', { class: 'ed-side-label', text: '結果の出し方' }),
      radio('manual', '先生が表示するまで出さない'),
      radio('live', 'すぐ表示')),
    el('p', { class: 'ed-note', text: POLL_NOTE }));
}

export const CLOUD_NOTE = '生徒は短い言葉を 3 つまで送ります。多くの人が書いた言葉ほど大きく映ります。次のスライドへ進むと締め切ります。';

// 質問文だけを持つスライド（自由記述・ワードクラウド）の右の列。
// 入力中は右の列を描き直さず、中央の見本だけ ed.patchSlide で更新する
function renderQuestionSettings(host, ed, title, note) {
  const slide = ed.currentSlide();
  const question = el('textarea', {
    id: 'ed-free-question', rows: '4', value: slide.question || '',
    oninput: () => ed.patchSlide({ question: question.value }),
  });
  host.replaceChildren(
    el('h2', { class: 'ed-col-title', text: title }),
    el('div', { class: 'field' }, el('label', { class: 'label', for: 'ed-free-question', text: '質問文' }), question),
    el('p', { class: 'ed-note', text: note }));
}

// 自由記述の右の列（質問文だけ）
export function renderFreeSettings(host, ed) {
  renderQuestionSettings(host, ed, '自由記述の設定', FREE_NOTE);
}

// ワードクラウドの右の列（質問文だけ）
export function renderCloudSettings(host, ed) {
  renderQuestionSettings(host, ed, 'ワードクラウドの設定', CLOUD_NOTE);
}

// アンケートの中央（質問文と選択肢）
export function renderPollForm(host, ed, { focusOption = -1 } = {}) {
  const slide = ed.currentSlide();
  const options = slide.options || [];
  const { minOptions, maxOptions } = CONFIG.poll;

  const question = el('textarea', {
    id: 'ed-poll-question', rows: '3', value: slide.question || '',
    oninput: () => ed.patchSlide({ question: question.value }, { quiet: true }),
  });

  const setOption = (i, value) => {
    const next = [...(ed.currentSlide().options || [])];
    next[i] = value;
    ed.patchSlide({ options: next }, { quiet: true });
  };
  const removeOption = (i) => {
    const next = (ed.currentSlide().options || []).filter((_, k) => k !== i);
    ed.patchSlide({ options: next });
    renderPollForm(host, ed, { focusOption: Math.min(i, next.length - 1) });
  };
  const addOption = () => {
    const next = [...(ed.currentSlide().options || []), ''];
    ed.patchSlide({ options: next });
    renderPollForm(host, ed, { focusOption: next.length - 1 });
  };

  const rows = options.slice(0, maxOptions).map((opt, i) => {
    const mark = OPTION_MARKS[i];
    const input = el('input', {
      type: 'text', class: 'ed-opt-input', 'aria-label': `選択肢 ${mark}`, value: String(opt ?? ''),
      oninput: () => setOption(i, input.value),
    });
    return el('li', { class: 'ed-opt' },
      el('span', { class: 'ed-opt-mark', 'aria-hidden': 'true', text: mark }),
      input,
      el('button', {
        type: 'button', class: 'btn', text: '削除', 'aria-label': `選択肢 ${mark} を削除`,
        disabled: options.length <= minOptions, onclick: () => removeOption(i),
      }));
  });

  host.replaceChildren(el('div', { class: 'ed-poll card' },
    el('h2', { class: 'ed-col-title', text: 'アンケート' }),
    el('div', { class: 'field' }, el('label', { class: 'label', for: 'ed-poll-question', text: '質問文' }), question),
    el('p', { class: 'label ed-side-label', id: 'ed-opts-label', text: `選択肢（${minOptions}〜${maxOptions} 個）` }),
    el('ol', { class: 'ed-opts', 'aria-labelledby': 'ed-opts-label' }, rows),
    el('button', {
      type: 'button', class: 'btn', text: '＋ 選択肢を追加', disabled: options.length >= maxOptions, onclick: addOption,
    })));

  if (focusOption >= 0) host.querySelectorAll('.ed-opt-input')[focusOption]?.focus();
}
