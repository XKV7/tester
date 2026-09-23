/** 입력 이벤트: event.timeStamp(performance.now 기준)를 그대로 보관해 프레임 대기 지연을 없앤다. */
export interface InputEvent {
  kind: 'down' | 'up';
  ts: number;
  /** 키/포인터 식별자. */
  id: string;
}

const INTERACTIVE = 'button, input, select, textarea, a, label, .ui-interactive';

/** 아무 키(Esc 제외) / 터치 입력 수집. */
export class InputCollector {
  private queue: InputEvent[] = [];
  private held = new Set<string>();
  private readonly offs: (() => void)[] = [];
  onEscape: (() => void) | null = null;
  onAny: (() => void) | null = null;

  constructor(private readonly opts: { pointerTarget?: HTMLElement } = {}) {}

  attach(): void {
    const kd = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.onEscape?.();
        return;
      }
      if (isTyping(e.target)) return;
      if (e.repeat) {
        e.preventDefault();
        return;
      }
      // 브라우저 기본 동작(스크롤, 탭 이동 등) 억제. 새로고침·개발자 도구 같은 조합은 허용.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !/^F\d+$/.test(e.key)) e.preventDefault();
      if (this.held.has(e.code)) return;
      this.held.add(e.code);
      this.queue.push({ kind: 'down', ts: e.timeStamp, id: e.code });
      this.onAny?.();
    };
    const ku = (e: KeyboardEvent) => {
      if (!this.held.delete(e.code)) return;
      this.queue.push({ kind: 'up', ts: e.timeStamp, id: e.code });
    };
    const pd = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest && t.closest(INTERACTIVE)) return;
      if (this.opts.pointerTarget && t && !this.opts.pointerTarget.contains(t) && !t.closest('#ui')) return;
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const id = 'p' + e.pointerId;
      this.held.add(id);
      this.queue.push({ kind: 'down', ts: e.timeStamp, id });
      this.onAny?.();
    };
    const pu = (e: PointerEvent) => {
      const id = 'p' + e.pointerId;
      if (!this.held.delete(id)) return;
      this.queue.push({ kind: 'up', ts: e.timeStamp, id });
    };
    const blur = () => {
      const now = performance.now();
      for (const id of this.held) this.queue.push({ kind: 'up', ts: now, id });
      this.held.clear();
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('pointerdown', pd);
    window.addEventListener('pointerup', pu);
    window.addEventListener('pointercancel', pu);
    window.addEventListener('blur', blur);
    this.offs.push(
      () => window.removeEventListener('keydown', kd),
      () => window.removeEventListener('keyup', ku),
      () => window.removeEventListener('pointerdown', pd),
      () => window.removeEventListener('pointerup', pu),
      () => window.removeEventListener('pointercancel', pu),
      () => window.removeEventListener('blur', blur),
    );
  }

  detach(): void {
    for (const f of this.offs.splice(0)) f();
    this.queue = [];
    this.held.clear();
  }

  /** 대기 중인 입력을 시간순으로 꺼낸다. */
  drain(): InputEvent[] {
    const q = this.queue;
    this.queue = [];
    return q.sort((a, b) => a.ts - b.ts);
  }

  get anyHeld(): boolean {
    return this.held.size > 0;
  }

  clear(): void {
    this.queue = [];
  }
}

const NON_TEXT = new Set(['checkbox', 'radio', 'button', 'range', 'color', 'file', 'submit', 'reset']);
/** 텍스트 입력 중인지 (단축키 무시 판단). */
export function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return true;
  return el.tagName === 'INPUT' && !NON_TEXT.has((el as HTMLInputElement).type);
}
