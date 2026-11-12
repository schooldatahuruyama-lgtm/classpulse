// スライド編集: 右の列（選んだ要素の設定）と、アンケート・クイズ・5 段階評価の入力欄・設定
import { el } from '../../ui.js';
import { TEXT_COLORS, OPTION_MARKS } from '../../slide-render.js';
import { CONFIG } from '../../config.js';
import { removeOption as withoutOption, quizCorrect } from '../../model.js';

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

export const QUIZ_NOTE = 'このクイズは匿名です。正解は、発表の画面で「正解を表示」を押すまで生徒の端末に届きません。正解を表示すると、その質問を締め切ります。次のスライドへ進んでも締め切ります。';

export const RATING_NOTE = '生徒は 1〜5 から 1 つ選びます。この質問は匿名です。次のスライドへ進むと締め切ります。締め切る前は、生徒は答えを変えられます。';

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

// 結果の出し方と説明の右の列（アンケート・5 段階評価）
function renderResultModeSettings(host, ed, title, note) {
  const slide = ed.currentSlide();
  const radio = (value, label) => el('label', { class: 'ed-radio' },
    el('input', {
      type: 'radio', name: 'ed-result-mode', value, checked: slide.resultMode === value,
      'aria-labelledby': `ed-result-mode-${value}`, // 読み上げの名前は日本語の文（値の manual / live ではなく）
      onchange: () => ed.patchSlide({ resultMode: value }),
    }),
    el('span', { id: `ed-result-mode-${value}`, text: label }));
  host.replaceChildren(
    el('h2', { class: 'ed-col-title', text: title }),
    el('fieldset', { class: 'ed-fieldset' },
      el('legend', { class: 'ed-side-label', text: '結果の出し方' }),
      radio('manual', '先生が表示するまで出さない'),
      radio('live', 'すぐ表示')),
    el('p', { class: 'ed-note', text: note }));
}

// アンケートの右の列（結果の出し方と説明）
export function renderPollSettings(host, ed) {
  renderResultModeSettings(host, ed, 'アンケートの設定', POLL_NOTE);
}

// 5 段階評価の右の列（結果の出し方と説明）
export function renderRatingSettings(host, ed) {
  renderResultModeSettings(host, ed, '5 段階評価の設定', RATING_NOTE);
}

// クイズの右の列（説明だけ。結果の出し方は無い。正解は先生が「正解を表示」で出す）
export function renderQuizSettings(host) {
  host.replaceChildren(
    el('h2', { class: 'ed-col-title', text: 'クイズの設定' }),
    el('p', { class: 'ed-note', text: QUIZ_NOTE }));
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

// アンケート・クイズの中央（質問文と選択肢。クイズは選択肢ごとに「正解」を選ぶ所も）
// focusOption: 描いたあとにフォーカスを置く選択肢の入力欄、focusCorrect: 同じく「正解」を選ぶ所
export function renderPollForm(host, ed, { focusOption = -1, focusCorrect = -1 } = {}) {
  const slide = ed.currentSlide();
  const isQuiz = slide.type === 'quiz';
  const options = slide.options || [];
  const correct = isQuiz ? quizCorrect(slide) : -1;
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
  // 選択肢を消す: model の removeOption で options と（クイズの）正解を一緒に変える（正解が別の選択肢にずれない）
  const removeOption = (i) => {
    const next = withoutOption(ed.currentSlide(), i);
    ed.patchSlide(next);
    renderPollForm(host, ed, { focusOption: Math.min(i, next.options.length - 1) });
  };
  const addOption = () => {
    const next = [...(ed.currentSlide().options || []), ''];
    ed.patchSlide({ options: next });
    renderPollForm(host, ed, { focusOption: next.length - 1 });
  };
  const setCorrect = (i) => {
    ed.patchSlide({ correct: i });
    renderPollForm(host, ed, { focusCorrect: i });
  };

  const rows = options.slice(0, maxOptions).map((opt, i) => {
    const mark = OPTION_MARKS[i];
    const input = el('input', {
      type: 'text', class: 'ed-opt-input', 'aria-label': `選択肢 ${mark}`, value: String(opt ?? ''),
      oninput: () => setOption(i, input.value),
    });
    const on = i === correct;
    // 正解を選ぶ所（ラジオボタン。1 つだけ選べる）。選んだ行は「○ 正解」の文字と枠で示す（色だけに頼らない）
    const correctPick = isQuiz
      ? el('label', { class: on ? 'ed-radio ed-opt-correct is-on' : 'ed-radio ed-opt-correct' },
        el('input', {
          type: 'radio', name: 'ed-quiz-correct', class: 'ed-opt-correct-input', checked: on,
          'aria-label': `選択肢 ${mark} を正解にする`,
          onchange: () => setCorrect(i),
        }),
        el('span', { text: on ? '○ 正解' : '正解にする' }))
      : null;
    return el('li', { class: on ? 'ed-opt is-correct' : 'ed-opt' },
      el('span', { class: 'ed-opt-mark', 'aria-hidden': 'true', text: mark }),
      input,
      el('button', {
        type: 'button', class: 'btn', text: '削除', 'aria-label': `選択肢 ${mark} を削除`,
        disabled: options.length <= minOptions, onclick: () => removeOption(i),
      }),
      correctPick);
  });

  host.replaceChildren(el('div', { class: 'ed-poll card' },
    el('h2', { class: 'ed-col-title', text: isQuiz ? 'クイズ' : 'アンケート' }),
    el('div', { class: 'field' }, el('label', { class: 'label', for: 'ed-poll-question', text: '質問文' }), question),
    el('p', { class: 'label ed-side-label', id: 'ed-opts-label', text: `選択肢（${minOptions}〜${maxOptions} 個）${isQuiz ? 'と正解' : ''}` }),
    el('ol', { class: 'ed-opts', 'aria-labelledby': 'ed-opts-label' }, rows),
    el('button', {
      type: 'button', class: 'btn', text: '＋ 選択肢を追加', disabled: options.length >= maxOptions, onclick: addOption,
    })));

  if (focusOption >= 0) host.querySelectorAll('.ed-opt-input')[focusOption]?.focus();
  if (focusCorrect >= 0) host.querySelectorAll('.ed-opt-correct-input')[focusCorrect]?.focus();
}

// 5 段階評価の中央（質問文・両はしの言葉と、スライドの見本）。
// 入力中は描き直さず、見本（preview）だけを、ed.patchSlide のあとに編集の画面が描き直す
export function renderRatingForm(host, ed, preview) {
  const slide = ed.currentSlide();
  const max = CONFIG.rating.labelMaxLength;
  const question = el('textarea', {
    id: 'ed-rating-question', rows: '3', value: slide.question || '',
    oninput: () => ed.patchSlide({ question: question.value }),
  });
  const labelInput = (id, key) => {
    const input = el('input', {
      type: 'text', id, class: 'ed-rating-label', maxlength: String(max), value: String(slide[key] ?? ''),
      oninput: () => ed.patchSlide({ [key]: input.value }),
    });
    return input;
  };
  host.replaceChildren(el('div', { class: 'ed-poll ed-rating card' },
    el('h2', { class: 'ed-col-title', text: '5 段階評価' }),
    el('div', { class: 'field' }, el('label', { class: 'label', for: 'ed-rating-question', text: '質問文' }), question),
    el('div', { class: 'field' },
      el('label', { class: 'label', for: 'ed-rating-low', text: `1 の側の言葉（${max} 文字まで。空でもよい）` }),
      labelInput('ed-rating-low', 'lowLabel')),
    el('div', { class: 'field' },
      el('label', { class: 'label', for: 'ed-rating-high', text: `5 の側の言葉（${max} 文字まで。空でもよい）` }),
      labelInput('ed-rating-high', 'highLabel')),
    el('p', { class: 'muted', text: '生徒の画面には 1〜5 のボタンが横に並び、両はしに言葉が出ます。' }),
    preview));
}
