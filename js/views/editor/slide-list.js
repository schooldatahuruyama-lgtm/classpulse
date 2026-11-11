// スライド編集: 左の列（スライドの縮小表示、追加、上へ・下へ・複製・削除）
import { el } from '../../ui.js';
import { renderSlide } from '../../slide-render.js';

const kindLabel = (slide) => (slide && slide.type === 'poll' ? 'アンケート' : '資料');

// 追加のボタン（左の列と、スライドが無いときの中央で使う）
export function addButtons(ed) {
  return el('div', { class: 'ed-add' },
    el('button', { type: 'button', class: 'btn', text: '＋ 資料スライド', onclick: () => ed.addSlide('content') }),
    el('button', { type: 'button', class: 'btn', text: '＋ アンケート', onclick: () => ed.addSlide('poll') }));
}

function slideActions(ed) {
  const { order } = ed.state.deck;
  const at = order.indexOf(ed.state.slideId);
  if (at < 0) return null;
  const n = at + 1;
  return el('div', { class: 'ed-slide-actions', role: 'group', 'aria-labelledby': 'ed-slide-actions-label' },
    el('p', { id: 'ed-slide-actions-label', class: 'ed-side-label', text: `選んだスライド（${n} 枚目）` }),
    el('div', { class: 'ed-btn-grid' },
      el('button', { type: 'button', class: 'btn', text: '上へ', dataset: { focusKey: 'up' }, 'aria-label': `${n} 枚目を上へ`, disabled: at === 0, onclick: () => ed.moveSlide(-1) }),
      el('button', { type: 'button', class: 'btn', text: '下へ', dataset: { focusKey: 'down' }, 'aria-label': `${n} 枚目を下へ`, disabled: at === order.length - 1, onclick: () => ed.moveSlide(1) }),
      el('button', { type: 'button', class: 'btn', text: '複製', 'aria-label': `${n} 枚目を複製`, onclick: () => ed.duplicateSlide() }),
      el('button', { type: 'button', class: 'btn btn-danger', text: '削除', 'aria-label': `${n} 枚目を削除`, onclick: () => ed.deleteSlide() })));
}

export function renderSlideList(host, ed) {
  const { deck, slideId } = ed.state;
  const list = el('ol', { class: 'ed-slides' });
  deck.order.forEach((id, i) => {
    const slide = deck.slides[id];
    const selected = id === slideId;
    const thumb = el('span', { class: 'ed-thumb' });
    renderSlide(thumb, slide, deck.images, { mode: 'thumb' });
    list.append(el('li', {},
      el('button', {
        type: 'button', class: 'ed-slide-btn', dataset: { slideId: id },
        'aria-current': selected ? 'true' : false,
        'aria-label': `${i + 1} 枚目（${kindLabel(slide)}）${selected ? '、選択中' : ''}`,
        onclick: () => ed.selectSlide(id),
      },
      el('span', { class: 'ed-slide-num', 'aria-hidden': 'true' },
        el('span', { text: String(i + 1) }),
        selected ? el('span', { class: 'ed-slide-current', text: '選択中' }) : null),
      thumb)));
  });

  const actions = slideActions(ed);
  host.replaceChildren(...[
    el('h2', { class: 'ed-col-title', text: 'スライド' }),
    deck.order.length ? list : el('p', { class: 'muted', text: 'スライドがありません。下のボタンで追加してください。' }),
    addButtons(ed),
    actions,
  ].filter(Boolean));

  // 選んだスライドが見えるように
  const current = host.querySelector('[aria-current="true"]');
  if (current && typeof current.scrollIntoView === 'function') current.scrollIntoView({ block: 'nearest' });
}

// 1 枚の縮小表示だけ描き直す
export function updateThumb(host, ed, slideId) {
  const btn = [...host.querySelectorAll('.ed-slide-btn')].find((b) => b.dataset.slideId === slideId);
  const thumb = btn && btn.querySelector('.ed-thumb');
  if (thumb) renderSlide(thumb, ed.state.deck.slides[slideId], ed.state.deck.images, { mode: 'thumb' });
}
