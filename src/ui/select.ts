import { audio } from '../audio/engine';
import { library } from '../levels/library';
import { loadPackageAudio, packageFromFileList, PackageError, type LevelPackage } from '../levels/package';
import { getBest, settings } from '../game/settings';
import { ambient } from '../render/stage';
import { alertBox, fileInput, h, isTyping, show, stars, type Screen } from './dom';
import { PlayScreen } from './play';
import { speedSelect } from './speed';
import { TitleScreen } from './title';

let lastSelected: string | null = null;
let lastAuto = false;

/** 레벨 선택: 카드 목록 + 미리듣기. */
export class SelectScreen implements Screen {
  private sel: LevelPackage | null = null;
  private cards!: HTMLElement;
  private previewToken = 0;
  private keyHandler = (e: KeyboardEvent) => {
    if (isTyping(e.target)) return;
    if (e.key === 'Escape') void show(new TitleScreen());
    else if (e.key === 'Enter' && this.sel) this.play();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      const items = library.items;
      const i = this.sel ? items.indexOf(this.sel) : -1;
      const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
      this.select(items[(i + d + items.length) % items.length]);
      e.preventDefault();
    }
  };
  private autoBox!: HTMLInputElement;

  enter(root: HTMLElement): void {
    ambient(true);
    const pickFiles = fileInput({ accept: '.zip,.json,audio/*,image/*', multiple: true }, (f) => this.load(f));
    const pickDir = fileInput({ directory: true }, (f) => this.load(f));
    this.cards = h('div', { class: 'cards' });
    this.autoBox = h('input', { type: 'checkbox', checked: lastAuto, onchange: () => (lastAuto = this.autoBox.checked) });
    root.append(
      h(
        'div',
        { class: 'page' },
        h(
          'div',
          { class: 'page-head' },
          h('button', { class: 'btn small', onclick: () => show(new TitleScreen()) }, '← 뒤로'),
          h('h1', null, '레벨 선택'),
          pickFiles,
          pickDir,
          h('button', { class: 'btn small', onclick: () => pickFiles.click() }, '레벨 불러오기 (zip / json)'),
          h('button', { class: 'btn small', onclick: () => pickDir.click() }, '폴더 불러오기'),
        ),
        h('div', { class: 'page-body' }, this.cards),
        h(
          'div',
          { class: 'select-bar' },
          h('label', { class: 'row' }, this.autoBox, '자동 플레이'),
          h('label', { class: 'row' }, '속도', h('div', { style: 'width:120px' }, speedSelect())),
          h('span', { class: 'grow dim' }, 'Enter로 시작 · 방향키로 선택'),
          h('button', { class: 'btn primary', onclick: () => this.play() }, '플레이'),
        ),
      ),
    );
    this.render();
    const init = (lastSelected && library.get(lastSelected)) || library.items[0];
    if (init) this.select(init);
    window.addEventListener('keydown', this.keyHandler);
  }

  private render(): void {
    this.cards.innerHTML = '';
    for (const p of library.items) {
      const m = p.level.meta;
      const best = getBest(p.id);
      const card = h(
        'div',
        { class: 'card' + (p === this.sel ? ' sel' : ''), onclick: () => this.select(p), ondblclick: () => this.play() },
        h('h3', null, m.title, p.builtin ? h('span', { class: 'tag' }, p.id.startsWith('bundled-') ? '포함됨' : '데모') : null),
        h('div', { class: 'meta' }, `${m.artist}${m.author ? ' · 제작 ' + m.author : ''}`),
        h('div', { class: 'meta' }, `${p.level.settings.bpm} BPM · ${p.level.path.length + 1} 타일`),
        h('div', { class: 'stars' }, stars(m.difficulty)),
        h('div', { class: 'best' }, best === null ? '기록 없음' : `최고 정확도 ${best.toFixed(2)}%`),
      );
      this.cards.append(card);
    }
  }

  private select(p: LevelPackage): void {
    if (this.sel === p) return;
    this.sel = p;
    lastSelected = p.id;
    this.render();
    void this.preview(p);
  }

  /** previewStart부터 페이드 인 미리듣기. */
  private async preview(p: LevelPackage): Promise<void> {
    const token = ++this.previewToken;
    const eng = audio();
    await eng.resume();
    const buf = await loadPackageAudio(p);
    if (token !== this.previewToken) return;
    const g = eng.musicGain.gain;
    const t = eng.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(settings.musicVolume, t + 1.2);
    const start = Math.min(p.level.meta.previewStart, Math.max(0, buf.duration - 2));
    eng.play(buf, start, p.level.settings.pitch, p.level.settings.volume, 0.05);
  }

  private async load(files: FileList): Promise<void> {
    try {
      const pkg = await packageFromFileList(files);
      library.add(pkg);
      this.sel = null;
      this.select(pkg);
      if (pkg.warnings.length) await alertBox('불러오기 경고', pkg.warnings);
    } catch (e) {
      const lines = e instanceof PackageError ? e.details : [(e as Error).message];
      await alertBox('레벨을 불러올 수 없습니다', lines);
    }
  }

  private play(): void {
    if (!this.sel) return;
    const p = this.sel;
    void show(new PlayScreen(p, { autoplay: this.autoBox.checked, back: () => new SelectScreen() }));
  }

  exit(): void {
    ambient(false);
    this.previewToken++;
    window.removeEventListener('keydown', this.keyHandler);
    const eng = audio();
    eng.stop();
    const g = eng.musicGain.gain;
    g.cancelScheduledValues(eng.ctx.currentTime);
    g.setValueAtTime(settings.musicVolume, eng.ctx.currentTime);
  }
}
