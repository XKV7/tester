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
