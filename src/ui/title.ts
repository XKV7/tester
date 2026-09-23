import { compileChart, orbiterAngle } from '../core/chart';
import { emptyLevel } from '../core/level';
import { floorIndex, TILE_LEN } from '../core/math';
import { VisualTimeline } from '../core/timeline';
import { PlanetsView } from '../render/planets';
import { stage } from '../render/stage';
import { TrackView } from '../render/track';
import { h, show, type Screen } from './dom';
import { SelectScreen } from './select';
import { SettingsScreen } from './settings';

/** 타이틀: 배경에서 두 행성이 천천히 공전하는 데모. */
export class TitleScreen implements Screen {
  private tick = () => this.frame();
  private track!: TrackView;
  private planets!: PlanetsView;
  private chart = (() => {
    const lv = emptyLevel();
    lv.settings.bpm = 50;
    lv.settings.offset = 0;
    lv.settings.trackColor = '#2a2f45';
    // 둥근 팔각 고리 (계속 반복)
    lv.path = Array.from({ length: 64 }, (_, i) => (i * 45) % 360);
    return compileChart(lv);
  })();
  private t0 = performance.now();

  enter(root: HTMLElement): void {
    const tl = new VisualTimeline(this.chart);
    this.track = new TrackView(this.chart, tl);
    this.track.container.alpha = 0.55;
    this.planets = new PlanetsView();
    stage.clearWorld();
    stage.world.addChild(this.track.container, this.planets.container);
    stage.setBackground(0x0e0f16);
    stage.camera.snap(50, -120.7, 0.9, 0);
    stage.app.ticker.add(this.tick);

    root.append(
      h(
        'div',
        { class: 'center-screen' },
        h('h1', { class: 'logo' }, 'ORBIT'),
        h('div', { class: 'tagline' }, '길의 모양이 곧 리듬이다'),
        h(
          'div',
          { class: 'menu' },
          h('button', { class: 'btn primary', onclick: () => show(new SelectScreen()) }, '시작'),
          h(
            'button',
            {
              class: 'btn',
              onclick: async () => {
                const { EditorScreen } = await import('../editor/editor');
                void show(new EditorScreen());
              },
            },
            '레벨 에디터',
          ),
          h('button', { class: 'btn', onclick: () => show(new SettingsScreen(() => new TitleScreen())) }, '설정'),
        ),
      ),
      h('div', { class: 'footer-note' }, `아무 키 또는 터치로 플레이 · Esc 일시정지 · 버전 ${__BUILD__}`),
    );
  }

  private frame(): void {
    const ch = this.chart;
    const t = ((performance.now() - this.t0) / 1000) % (ch.lastTime - 1);
    const cur = Math.min(floorIndex(ch.times, t), ch.finish - 1);
    const tile = ch.tiles[cur];
    // 고리를 계속 돌도록 8타일 주기로 위치를 접는다
    const loop = cur % 8;
    const pivot = this.track.pos(loop);
    const tail: number[] = [];
    for (let k = 1; k <= 8; k++) {
      const tt = t - (k * 0.15) / 8;
      if (tt < tile.time) break;
      tail.push(orbiterAngle(tile, tt));
    }
    this.planets.update(pivot, orbiterAngle(tile, t), TILE_LEN, tail, cur % 2 === 0, null);
    const dt = stage.tick();
    stage.camera.follow(50, -120.7, 0.9 + 0.05 * Math.sin(t * 0.3), 8 * Math.sin(t * 0.1), dt, 1);
    this.track.update({ passed: 0, pulse: 0, now: performance.now(), view: stage.viewRect() });
    stage.frame(0, 0);
  }

  exit(): void {
    stage.app.ticker.remove(this.tick);
    stage.clearWorld();
    this.track.destroy();
    this.planets.container.destroy({ children: true });
  }
}
