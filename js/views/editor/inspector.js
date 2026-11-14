// スライド編集: 右の列（選んだ要素の設定）と、アンケート・クイズ・5 段階評価の入力欄・設定
import { el } from '../../ui.js';
import { TEXT_COLORS, OPTION_MARKS, SHAPE_NAMES } from '../../slide-render.js';
import { CONFIG } from '../../config.js';
import { removeOption as withoutOption, quizCorrect, normalizeShapeItem } from '../../model.js';
import { parseYouTubeUrl, youTubeWatchUrl, formatVideoStart } from '../../video.js';
import { itemRows, nudge } from './phone-logic.js';

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

const STROKE_WIDTHS = [
  { value: 's', label: '細い' },
  { value: 'm', label: 'ふつう' },
  { value: 'l', label: '太い' },
];
const DIRS = [
  { value: 'h', label: 'よこ' },
  { value: 'v', label: 'たて' },
  { value: 'd1', label: 'ななめ ＼' },
  { value: 'd2', label: 'ななめ ／' },
];
const HEADS = [
  { value: 'end', label: '終わり' },
  { value: 'start', label: '始め' },
  { value: 'both', label: '両方' },
];
const BOTH_NONE_NOTE = '塗りと線の両方を「なし」にはできません。';

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

// 重なりの順番（文字・画像・図形のどれにも出す）
function layerButtons(ed, item) {
  return el('div', { class: 'ed-group', role: 'group', 'aria-labelledby': 'ed-layer' },
    el('p', { id: 'ed-layer', class: 'ed-side-label', text: '重なりの順番' }),
    el('div', { class: 'ed-btn-grid' },
      el('button', { type: 'button', class: 'btn', text: 'いちばん前へ', dataset: { focusKey: 'ed-layer:front' }, onclick: () => ed.moveItemLayer(item.id, true) }),
      el('button', { type: 'button', class: 'btn', text: 'いちばん後ろへ', dataset: { focusKey: 'ed-layer:back' }, onclick: () => ed.moveItemLayer(item.id, false) })));
}

// 色の丸いボタンの組。色の名前は読み上げの名前（aria-label）と、選んでいる色の文字で持つ。
// 選んでいる色は aria-pressed と、枠・「✓」の印で示す（色だけに頼らない）。
// 「なし」は、ななめの線が入った丸。noneDisabled のときは選べない
function colorGroup(id, label, colors, current, onPick, { none = false, noneDisabled = false } = {}) {
  const swatch = (value, name) => {
    const on = value === current;
    const disabled = value === 'none' && noneDisabled && !on;
    return el('button', {
      type: 'button', class: on ? 'ed-color is-on' : 'ed-color', disabled,
      'aria-pressed': on ? 'true' : 'false', 'aria-label': `${label}: ${name}`, title: name,
      dataset: { focusKey: `${id}:${value}` },
      onclick: () => onPick(value),
    },
    value === 'none'
      ? el('span', { class: 'ed-color-dot is-none', 'aria-hidden': 'true' })
      : el('span', { class: 'ed-color-dot', 'aria-hidden': 'true', style: `background:${value}` }),
    on ? el('span', { class: 'ed-color-check', 'aria-hidden': 'true', text: '✓' }) : null);
  };
  const currentName = current === 'none' ? 'なし' : (colors.find((c) => c.value === current)?.name ?? '');
  return el('div', { class: 'ed-group', role: 'group', 'aria-labelledby': id },
    el('p', { id, class: 'ed-side-label', text: label }),
    el('div', { class: 'ed-colors' },
      colors.map((c) => swatch(c.value, c.name)),
      none ? swatch('none', 'なし') : null),
    el('p', { class: 'small ed-color-now', text: `いまの色: ${currentName}` }));
}

// 図形の右の列（その種類で変えられるものだけ）
function renderShapeInspector(host, ed, raw) {
  const item = normalizeShapeItem(raw);
  const id = item.id;
  const isLine = item.shape === 'line' || item.shape === 'arrow';
  // いつも最新の要素に重ねて、正してから渡す（決まった値だけを保存する）
  const set = (patch) => {
    const cur = (ed.currentSlide()?.items || []).find((it) => it.id === id);
    if (cur) ed.updateItem(normalizeShapeItem({ ...cur, ...patch }), { refresh: true, side: true });
  };
  const all = CONFIG.shape.colors;
  const lineColors = all.filter((c) => c.stroke);
  const oneNone = !isLine && (item.fill === 'none' || item.stroke === 'none');
  // replaceChildren は null を文字にしてしまうので、出さない部品を除いてから渡す
  host.replaceChildren(...[
    el('h2', { class: 'ed-col-title', text: `図形の設定（${SHAPE_NAMES[item.shape]}）` }),
    isLine ? null : colorGroup('ed-fill', '塗りの色', all, item.fill, (v) => set({ fill: v }), { none: true, noneDisabled: item.stroke === 'none' }),
    colorGroup('ed-stroke', '線の色', lineColors, item.stroke, (v) => set({ stroke: v }), { none: !isLine, noneDisabled: item.fill === 'none' }),
    oneNone ? el('p', { class: 'small muted', text: BOTH_NONE_NOTE }) : null,
    choiceGroup('ed-stroke-width', '線の太さ', STROKE_WIDTHS, item.strokeWidth, (v) => set({ strokeWidth: v })),
    isLine ? choiceGroup('ed-dir', '向き', DIRS, item.dir, (v) => set({ dir: v })) : null,
    item.shape === 'arrow' ? choiceGroup('ed-head', '矢印の先', HEADS, item.head, (v) => set({ head: v })) : null,
    layerButtons(ed, item),
    deleteItemButton(ed, item),
  ].filter(Boolean));
}

// 資料スライドの右の列
function renderSelectedItemInspector(host, ed) {
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
      layerButtons(ed, item),
      deleteItemButton(ed, item));
    return;
  }
  if (item.kind === 'shape') {
    renderShapeInspector(host, ed, item);
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
    layerButtons(ed, item),
    deleteItemButton(ed, item));
}

// 要素の一覧と微調整は、せまい画面だけ出す（外わくは編集画面が持つ）。
export function renderItemInspector(host, ed) {
  const selectedId = ed.state.itemId;
  const items = ed.currentSlide()?.items || [];
  const item = items.find((it) => it.id === selectedId);
  const previous = host.querySelector('.ed-item-picker');
  const open = previous && previous.dataset.selectedId === (selectedId || '') ? previous.open : !item;
  const rows = itemRows(items, selectedId);
  const picker = el('details', { class: 'ed-item-picker ed-phone-only', open, dataset: { selectedId: selectedId || '' } },
    el('summary', { text: '要素を選ぶ', dataset: { focusKey: 'ed-item-picker' } }),
    rows.length ? el('div', { class: 'ed-item-rows' }, rows.map((row) => el('button', {
      type: 'button', class: 'btn ed-item-row', 'aria-pressed': row.selected ? 'true' : 'false',
      dataset: { focusKey: `ed-pick:${row.id}` }, onclick: () => ed.selectItem(row.id),
    }, row.selected ? el('span', { 'aria-hidden': 'true', text: '✓' }) : null, el('span', { text: row.label }))))
      : el('p', { class: 'muted', text: '要素がありません。「文字を追加」などで足してください。' }));
  renderSelectedItemInspector(host, ed);
  if (item) {
    const directions = [['left', '←', '左へ'], ['right', '→', '右へ'], ['up', '↑', '上へ'], ['down', '↓', '下へ']];
    const move = el('div', { class: 'ed-group ed-phone-only', role: 'group', 'aria-labelledby': 'ed-nudge' },
      el('p', { id: 'ed-nudge', class: 'ed-side-label', text: '位置を少し動かす' }),
      el('div', { class: 'ed-nudge-buttons' }, directions.map(([dir, mark, label]) => el('button', {
        type: 'button', class: 'btn', text: mark, 'aria-label': label, dataset: { focusKey: `ed-nudge:${dir}` },
        onclick: () => {
          const cur = (ed.currentSlide()?.items || []).find((it) => it.id === selectedId);
          if (cur) ed.updateItem(nudge(cur, dir), { refresh: true });
        },
      }))));
    host.insertBefore(move, host.children[1] || null);
  }
  host.insertBefore(picker, host.children[0] || null);
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

// 入力した URL は欄の中だけに持つ。保存するのは読み取れた ID と開始秒だけ。
export function renderVideoSettings(host, ed) {
  const slide = ed.currentSlide();
  const status = el('p', { id: 'ed-video-status', class: 'small', role: 'status' });
  const updateStatus = (parsed) => {
    const invalid = url.value.trim() !== '' && !parsed;
    status.setAttribute('role', invalid ? 'alert' : 'status');
    status.textContent = invalid ? 'YouTube の動画の URL を入れてください。'
      : parsed ? `動画を読み取りました。${parsed.start > 0 ? `${formatVideoStart(parsed.start)}から始めます。` : ''}` : '';
  };
  const url = el('input', {
    id: 'ed-video-url', type: 'text', inputmode: 'url', value: youTubeWatchUrl(slide),
    'aria-describedby': 'ed-video-status',
    oninput: () => {
      const parsed = parseYouTubeUrl(url.value);
      ed.patchSlide(parsed || { videoId: '', start: 0 });
      updateStatus(parsed);
    },
  });
  const caption = el('input', {
    id: 'ed-video-caption', type: 'text', maxlength: String(CONFIG.video.captionMaxLength), value: slide.caption || '',
    oninput: () => ed.patchSlide({ caption: caption.value }),
  });
  updateStatus(parseYouTubeUrl(url.value));
  host.replaceChildren(
    el('h2', { class: 'ed-col-title', text: '動画の設定' }),
    el('div', { class: 'field' }, el('label', { class: 'label', for: 'ed-video-url', text: 'YouTube の URL' }), url, status),
    el('div', { class: 'field' }, el('label', { class: 'label', for: 'ed-video-caption', text: '題（生徒の画面に出ます。省略できます）' }), caption),
    el('p', { class: 'ed-note', text: '動画は、発表の画面（教室の画面）で再生します。生徒の端末では再生しません。学校のネットワークで YouTube が見られないときは、使えません。' }));
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
