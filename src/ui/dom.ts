type Child = Node | string | null | undefined | false;
type Attrs = Record<string, unknown> & { class?: string; style?: string };

/** 간단한 DOM 생성 헬퍼. on* 속성은 이벤트 리스너로 연결. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'style') el.setAttribute('style', String(v));
      else if (k in el && k !== 'list') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export interface Screen {
  enter(root: HTMLElement): void | Promise<void>;
  exit(): void;
}

let current: Screen | null = null;
let root: HTMLElement;

export function initUi(el: HTMLElement): void {
  root = el;
}

export async function show(s: Screen): Promise<void> {
  current?.exit();
  root.innerHTML = '';
  root.className = '';
  current = s;
  await s.enter(root);
}

/** 모달 알림. */
export function alertBox(title: string, lines: string[]): Promise<void> {
  return new Promise((resolve) => {
    const close = () => {
      wrap.remove();
      resolve();
    };
    const wrap = h(
      'div',
      { class: 'modal-wrap ui-interactive' },
      h(
        'div',
        { class: 'modal' },
        h('h2', null, title),
        h('div', { class: 'modal-body' }, ...lines.map((l) => h('p', null, l))),
        h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: close }, '확인')),
      ),
    );
    document.body.appendChild(wrap);
    (wrap.querySelector('button') as HTMLButtonElement).focus();
  });
}

/** 확인/취소 모달 (window.confirm 대신 — 임베드 환경에서도 동작). */
export function confirmBox(title: string, message: string, okLabel = '확인'): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      wrap.remove();
      resolve(v);
    };
    const wrap = h(
      'div',
      { class: 'modal-wrap ui-interactive' },
      h(
        'div',
        { class: 'modal' },
        h('h2', null, title),
        h('div', { class: 'modal-body' }, h('p', null, message)),
        h(
          'div',
          { class: 'row end' },
          h('button', { class: 'btn', onclick: () => done(false) }, '취소'),
          h('button', { class: 'btn primary', onclick: () => done(true) }, okLabel),
        ),
      ),
    );
    document.body.appendChild(wrap);
    (wrap.querySelector('.btn.primary') as HTMLButtonElement).focus();
  });
}

/** 선택지 모달. 취소하면 null. */
export function choiceBox<T extends string>(title: string, message: string, options: { value: T; label: string; hint?: string }[]): Promise<T | null> {
  return new Promise((resolve) => {
    const done = (v: T | null) => {
      wrap.remove();
      resolve(v);
    };
    const wrap = h(
      'div',
      { class: 'modal-wrap ui-interactive' },
      h(
        'div',
        { class: 'modal' },
        h('h2', null, title),
        h('div', { class: 'modal-body' }, h('p', null, message)),
        h(
          'div',
          { class: 'col', style: 'margin:12px 0' },
          ...options.map((o) =>
            h('button', { class: 'btn', style: 'text-align:left', onclick: () => done(o.value) }, h('b', null, o.label), o.hint ? h('span', { class: 'dim' }, `  ${o.hint}`) : null),
          ),
        ),
        h('div', { class: 'row end' }, h('button', { class: 'btn ghost', onclick: () => done(null) }, '취소')),
      ),
    );
    document.body.appendChild(wrap);
    (wrap.querySelector('.col .btn') as HTMLButtonElement)?.focus();
  });
}

/** 잠깐 떠 있다 사라지는 알림. */
export function toast(text: string, ms = 2600): void {
  const el = h('div', { class: 'toast' }, text);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export const DIFFICULTY_CHOICES = [
  { value: 'easy' as const, label: '쉬움', hint: '주로 1박, 가끔 반박' },
  { value: 'normal' as const, label: '보통', hint: '반박 리듬 섞임' },
  { value: 'hard' as const, label: '어려움', hint: '곡의 잔 리듬까지' },
];

export function stars(n: number): string {
  const k = Math.max(0, Math.min(10, Math.round(n)));
  return '★'.repeat(Math.ceil(k / 2)) + '☆'.repeat(5 - Math.ceil(k / 2)) + ` ${k}`;
}

export function fileInput(opts: { accept?: string; multiple?: boolean; directory?: boolean }, onPick: (files: FileList) => void): HTMLInputElement {
  const inp = h('input', { type: 'file', accept: opts.accept, multiple: opts.multiple, style: 'display:none' });
  if (opts.directory) {
    inp.setAttribute('webkitdirectory', '');
    inp.setAttribute('directory', '');
  }
  inp.addEventListener('change', () => {
    if (inp.files && inp.files.length) onPick(inp.files);
    inp.value = '';
  });
  return inp;
}

export { isTyping } from '../game/input';
