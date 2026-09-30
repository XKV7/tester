import { Application, Container, Filter, Graphics, RenderTexture, Sprite, Texture, TexturePool, TilingSprite } from 'pixi.js';
import { TILE_LEN } from '../core/math';

// 필터(흐림·색·왜곡·빛 번짐)는 기본이 1배 해상도라, 휴대폰(2배 화면)에서 필터가 켜지면 화면 전체가 절반 해상도로 뭉개졌다.
// 화면 해상도를 따르게 한다 (필터를 만들기 전에).
Filter.defaultOptions.resolution = 'inherit';

/** WebGL이 끊겼을 때 안내 (새로고침하면 그림을 더 작게 올려 다시 그린다). */
function showContextLost(): void {
  if (document.getElementById('orbit-ctx-lost')) return;
  const box = document.createElement('div');
  box.id = 'orbit-ctx-lost';
  box.style.cssText =
    'position:fixed;left:50%;top:40%;transform:translate(-50%,-50%);z-index:100;max-width:86vw;padding:16px 18px;border-radius:12px;background:#1b1d2b;color:#e8e8f0;font:14px/1.5 system-ui,sans-serif;text-align:center;box-shadow:0 8px 30px #0008';
  box.textContent = '그래픽 메모리가 부족해 화면이 꺼졌어요. 새로고침하면 그림을 더 작게 올려 다시 그립니다. (에디터 레벨은 저장돼 있어요)';
  const btn = document.createElement('button');
  btn.textContent = '새로고침';
  btn.className = 'btn primary';
  btn.style.cssText = 'display:block;margin:12px auto 0';
  btn.onclick = () => location.reload();
  box.appendChild(btn);
  document.body.appendChild(box);
}

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  a: number;
}

/** 카메라 상태 (월드 좌표, y 반전된 화면 기준). */
export class Camera {
  x = 0;
  y = 0;
  zoom = 1;
  rotation = 0; // 도
  /** 화면 흔들림 (월드 단위, 보간 없이 그대로 더함). */
  shakeX = 0;
  shakeY = 0;
  /** 목표를 지수 감쇠로 따라감. dt: 초 (시각 보간 전용). */
  follow(tx: number, ty: number, tzoom: number, trot: number, dt: number, k = 6): void {
    const f = 1 - Math.exp(-k * dt);
    this.x += (tx - this.x) * f;
    this.y += (ty - this.y) * f;
    this.zoom += (tzoom - this.zoom) * (1 - Math.exp(-10 * dt));
    this.rotation += (trot - this.rotation) * (1 - Math.exp(-10 * dt));
  }
  snap(x: number, y: number, zoom = this.zoom, rot = this.rotation): void {
    this.x = x;
    this.y = y;
    this.zoom = zoom;
    this.rotation = rot;
  }
}

/** Pixi 앱 + 공통 레이어 (배경 입자, 월드, 플래시). 게임·에디터·타이틀이 공유한다. */
export class Stage {
  app!: Application;
  readonly bg = new Container();
  readonly world = new Container();
  /** world를 감싸는 변환 없는 층 — 화면 좌표 필터(빛 번짐)를 여기에 건다 */
  private readonly worldWrap = new Container();
  readonly overlay = new Container();
  private readonly flash = new Graphics();
  /** 배경 면 플래시 (배경 이미지 위, 트랙 아래) */
  private readonly bgFlash = new Graphics();
  private bgSprite: Sprite | TilingSprite | null = null;
  private bgImageUrl: string | null = null;
  private bgFit: 'cover' | 'contain' | 'unscaled' | 'tile' = 'cover';
  private bgTex: Texture | null = null;
  private bgVideoEl: HTMLVideoElement | null = null;
  private bgVideoSprite: Sprite | null = null;
  private bgVideoUrl: string | null = null;
  /** 날씨 입자 등 화면 좌표 오버레이 (플래시 아래). */
  readonly screenLayer = new Container();
  private motes: Mote[] = [];
  private readonly moteGfx = new Graphics();
  readonly camera = new Camera();
  private lastFrame = performance.now();
  private dt = 0.016;
  private bgColor = 0x0e0f16;

  async init(host: HTMLElement): Promise<void> {
    this.app = new Application();
    await this.app.init({
      resizeTo: host,
      background: this.bgColor,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      preference: 'webgl',
      // 장식의 오버레이·소프트 라이트·차이 섞기 (원작 blendMode)
      useBackBuffer: true,
    });
    host.appendChild(this.app.canvas);
    this.host = host;
    window.addEventListener('resize', this.layoutHost);
    // 화면 크기가 바뀌면(가로·세로 전환) Pixi가 예전 크기의 풀 텍스처를 지우는데, 필터 스택이 지난 프레임의
    // 입력 텍스처를 붙잡고 있어 다음 프레임부터 매번 오류가 나고 화면이 까매졌다 → 지우기 전에 참조를 끊는다
    const pool = TexturePool as unknown as { _pruneScreenTextures?: () => void };
    const prune = pool._pruneScreenTextures?.bind(TexturePool);
    const filterSys = (this.app.renderer as unknown as { filter?: { _filterStack?: ({ inputTexture: unknown } | undefined)[] } }).filter;
    if (prune) {
      pool._pruneScreenTextures = () => {
        for (const fd of filterSys?._filterStack ?? []) if (fd) fd.inputTexture = null;
        prune();
      };
    }
    // 전에 그래픽 메모리가 바닥났던 기기면 필터 해상도를 처음부터 낮춰 둔다
    try {
      if (localStorage.getItem('orbit.lowgpu') === '1') this.quality = 2;
    } catch {
      /* 무시 */
    }
    // 그래픽 메모리가 바닥나면 브라우저가 WebGL을 끊어 화면이 새까매진다 → 알리고 다음부터 가볍게
    this.app.canvas.addEventListener('webglcontextlost', () => {
      this.contextLost = true;
      try {
        localStorage.setItem('orbit.lowgpu', '1');
      } catch {
        /* 무시 */
      }
      showContextLost();
    });
    this.app.canvas.addEventListener('webglcontextrestored', () => (this.contextLost = false));
    this.bg.addChild(this.moteGfx, this.bgFlash);
    this.worldWrap.addChild(this.world);
    this.app.stage.addChild(this.bg, this.worldWrap, this.overlay);
    this.overlay.addChild(this.screenLayer, this.flash);
    for (let i = 0; i < 70; i++) {
      this.motes.push({
        x: Math.random(),
        y: Math.random(),
        vx: (Math.random() - 0.5) * 0.004,
        vy: (Math.random() - 0.5) * 0.004 - 0.002,
        r: 0.6 + Math.random() * 1.6,
        a: 0.05 + Math.random() * 0.18,
      });
    }
  }

  get width(): number {
    return this.app.screen.width;
  }
  get height(): number {
    return this.app.screen.height;
  }

  /** 원작 맵: 원작의 16:9 화면(세로 7타일 × 가로 약 12.4타일)이 다 들어오게 */
  fitWide = false;

  private host: HTMLElement | null = null;
  private frameAspect: number | null = null;
  /**
   * 게임 화면을 가운데 고정 비율 상자로 (원작 모니터 화면 그대로, 나머지는 검은 띠). null이면 화면 전체.
   */
  setFrameAspect(aspect: number | null): void {
    this.frameAspect = aspect;
    this.layoutHost();
  }
  private layoutHost = (): void => {
    const el = this.host;
    if (!el) return;
    const a = this.frameAspect;
    if (!a) {
      el.style.cssText = '';
    } else {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.min(vw, vh * a);
      const h = w / a;
      el.style.cssText = `inset:auto;left:${(vw - w) / 2}px;top:${(vh - h) / 2}px;width:${w}px;height:${h}px;box-shadow:0 0 0 100vmax #000`;
    }
    // 크기 바뀐 것을 바로 반영 (Pixi는 창 크기 이벤트 때만 다시 잰다)
    this.app?.resize();
  };

  /** 기본 배율: 화면 짧은 변에 약 7타일 (fitWide면 16:9 화면 전체가 들어오게). */
  get baseScale(): number {
    if (this.fitWide) return Math.min(this.width / ((TILE_LEN * 7 * 16) / 9), this.height / (TILE_LEN * 7));
    return Math.min(this.width, this.height) / (TILE_LEN * 7);
  }

  setBackground(color: number): void {
    if (color === this.bgColor) return;
    this.bgColor = color;
    this.app.renderer.background.color = color;
  }

  /**
   * 배경 이미지. fit: cover(화면 채움) · contain(전체 보이게) · unscaled(원래 크기, 가운데) · tile(바둑판).
   * tint: 색조, opacity: 불투명도 (기본 0.55 — 트랙이 잘 보이게).
   */
  setBackgroundImage(url: string | null, opts: { fit?: 'cover' | 'contain' | 'unscaled' | 'tile'; tint?: number; opacity?: number } = {}): void {
    const fit = opts.fit ?? 'cover';
    if (url !== this.bgImageUrl || fit !== this.bgFit) {
      this.bgImageUrl = url;
      this.bgFit = fit;
      if (this.bgSprite) {
        this.bgSprite.destroy();
        this.bgSprite = null;
      }
      this.bgTex = null;
      if (url) {
        const img = new Image();
        img.onload = () => {
          if (this.bgImageUrl !== url || this.bgFit !== fit) return;
          const tex = Texture.from(img);
          const s = fit === 'tile' ? new TilingSprite({ texture: tex, width: this.width, height: this.height }) : new Sprite(tex);
          this.bgTex = tex;
          this.bgSprite = s;
          this.bg.addChildAt(s, 0);
          this.layoutBg();
        };
        img.src = url;
      }
    }
    if (this.bgSprite) {
      this.bgSprite.alpha = opts.opacity ?? 0.55;
      this.bgSprite.tint = opts.tint ?? 0xffffff;
    }
  }

  /**
   * 배경 동영상 (소리 없음). time: 동영상에서 보여줄 시각(초), null이면 멈춤. rate: 재생 속도.
   * 조금씩 어긋나면 그대로 두고, 0.25초 넘게 어긋나면 맞춘다.
   */
  setBackgroundVideo(url: string | null, time: number | null = null, rate = 1, opts: { loop?: boolean; tint?: number; opacity?: number } = {}): void {
    if (url !== this.bgVideoUrl) {
      this.bgVideoUrl = url;
      if (this.bgVideoSprite) {
        this.bgVideoSprite.destroy({ texture: true, textureSource: true });
        this.bgVideoSprite = null;
      }
      if (this.bgVideoEl) {
        this.bgVideoEl.pause();
        this.bgVideoEl.removeAttribute('src');
        this.bgVideoEl.load();
        this.bgVideoEl = null;
      }
      if (url) {
        const v = document.createElement('video');
        v.muted = true;
        v.playsInline = true;
        v.preload = 'auto';
        v.crossOrigin = 'anonymous';
        v.src = url;
        this.bgVideoEl = v;
        v.addEventListener(
          'loadeddata',
          () => {
            if (this.bgVideoEl !== v) return;
            const s = new Sprite(Texture.from(v));
            this.bgVideoSprite = s;
            this.bg.addChildAt(s, this.bgSprite ? 1 : 0);
            this.layoutVideo();
          },
          { once: true },
        );
      }
    }
    const v = this.bgVideoEl;
    if (!v) return;
    v.loop = !!opts.loop;
    const dur = Number.isFinite(v.duration) ? v.duration : Infinity;
    let want = time;
    if (want !== null && opts.loop && dur < Infinity && dur > 0) want = ((want % dur) + dur) % dur;
    const visible = want !== null && want >= 0 && want < dur;
    if (this.bgVideoSprite) {
      this.bgVideoSprite.visible = want === null ? v.currentTime > 0 : visible;
      this.bgVideoSprite.alpha = opts.opacity ?? 1;
      this.bgVideoSprite.tint = opts.tint ?? 0xffffff;
      this.layoutVideo();
    }
    if (want === null || !visible) {
      if (!v.paused) v.pause();
      if (want !== null && want < 0 && v.currentTime !== 0 && v.readyState >= 1) v.currentTime = 0;
      return;
    }
    if (Math.abs(v.playbackRate - rate) > 0.001) v.playbackRate = rate;
    if (v.readyState >= 1 && Math.abs(v.currentTime - want) > 0.25) v.currentTime = want;
    if (v.paused) void v.play().catch(() => {});
  }

  private layoutVideo(): void {
    const s = this.bgVideoSprite;
    const v = this.bgVideoEl;
    if (!s || !v || !v.videoWidth) return;
    const k = Math.max(this.width / v.videoWidth, this.height / v.videoHeight);
    s.scale.set((k * v.videoWidth) / s.texture.width, (k * v.videoHeight) / s.texture.height);
    s.position.set((this.width - v.videoWidth * k) / 2, (this.height - v.videoHeight * k) / 2);
  }

  private layoutBg(): void {
    const s = this.bgSprite;
    const tex = this.bgTex;
    if (!s || !tex) return;
    if (s instanceof TilingSprite) {
      s.width = this.width;
      s.height = this.height;
      return;
    }
    const k =
      this.bgFit === 'unscaled' ? 1 : this.bgFit === 'contain' ? Math.min(this.width / tex.width, this.height / tex.height) : Math.max(this.width / tex.width, this.height / tex.height);
    s.scale.set(k);
    s.position.set((this.width - tex.width * k) / 2, (this.height - tex.height * k) / 2);
  }

  /** 잔상용: 트랙 층을 지우지 않고 계속 겹쳐 그리는 텍스처 (켜져 있을 때만). */
  private mirrorRT: RenderTexture | null = null;
  private mirrorSprite: Sprite | null = null;

  /**
   * 잔상 (원작 HallOfMirrors): 트랙 층(타일·행성·장식)을 지우지 않고 계속 겹쳐 그린다.
   * WebGL 화면은 매 프레임 지워지므로, 따로 쌓아 두는 텍스처에 그리고 그것을 보여 준다.
   */
  setMirrors(on: boolean): void {
    if (on === !!this.mirrorRT) {
      if (on && this.mirrorRT && (this.mirrorRT.width !== this.width || this.mirrorRT.height !== this.height)) this.mirrorRT.resize(this.width, this.height);
      return;
    }
    const stage = this.app.stage;
    if (on) {
      const rt = RenderTexture.create({ width: this.width, height: this.height, resolution: this.app.renderer.resolution });
      const sp = new Sprite(rt);
      const idx = stage.getChildIndex(this.worldWrap);
      stage.removeChild(this.worldWrap);
      stage.addChildAt(sp, idx);
      this.mirrorRT = rt;
      this.mirrorSprite = sp;
    } else {
      const sp = this.mirrorSprite!;
      const idx = stage.getChildIndex(sp);
      stage.removeChild(sp);
      stage.addChildAt(this.worldWrap, idx);
      sp.destroy();
      this.mirrorRT!.destroy(true);
      this.mirrorRT = null;
      this.mirrorSprite = null;
    }
  }

  /** 트랙 층 필터 (빛 번짐). */
  // ── 자동 화질: 필터가 켜진 채로 프레임이 계속 느리면 한 단계씩 낮춘다 ──
  // 0: 필터 = 화면 해상도, 1: 필터 1.5배, 2: 필터 1배, 3: 화면도 1.5배, 4: 화면도 1배
  private quality = 0;
  /** 그래픽 메모리 부족으로 WebGL이 끊겼는지 */
  contextLost = false;
  private frameEma = 16;
  private slowMs = 0;
  private get filterRes(): number | 'inherit' {
    return this.quality === 0 ? 'inherit' : this.quality === 1 ? 1.5 : 1;
  }
  /** 매 프레임 (게임 중에만): 걸린 시간(ms)과 필터가 켜져 있는지. */
  adaptQuality(frameMs: number, filtersOn: boolean): void {
    if (frameMs > 250) return; // 탭 전환·일시 멈춤은 무시
    this.frameEma += (frameMs - this.frameEma) * 0.05;
    // 약 40fps보다 느린 상태가 2초 이어지면 한 단계 내린다
    if (this.frameEma > 25 && filtersOn) this.slowMs += frameMs;
    else this.slowMs = Math.max(0, this.slowMs - frameMs);
    if (this.slowMs < 2000 || this.quality >= 4) return;
    this.slowMs = 0;
    this.frameEma = 16;
    this.quality++;
    const base = this.app.renderer.resolution;
    if (this.quality >= 3 && base > 1) {
      const r = this.quality === 3 ? Math.min(base, 1.5) : 1;
      this.app.renderer.resize(this.width, this.height, r);
    }
    console.info(`[ORBIT] 느려서 화질을 한 단계 낮춥니다 (단계 ${this.quality})`);
  }
  get qualityLevel(): number {
    return this.quality;
  }
  private applyRes(fs: Filter[]): void {
    const r = this.filterRes;
    for (const f of fs) if (f.resolution !== r) f.resolution = r;
  }

  setWorldFilters(fs: Filter[]): void {
    this.applyRes(fs);
    const w = this.worldWrap;
    if (fs.length === 0) {
      if (w.filters && (w.filters as Filter[]).length) w.filters = [];
      return;
    }
    w.filterArea = this.app.screen;
    w.filters = fs;
  }

  /** 화면 전체 필터 (없으면 빈 배열). */
  setScreenFilters(fs: Filter[]): void {
    this.applyRes(fs);
    const st = this.app.stage;
    if (fs.length === 0) {
      if (st.filters && (st.filters as Filter[]).length) st.filters = [];
      return;
    }
    st.filterArea = this.app.screen;
    st.filters = fs;
  }

  /** 프레임 간격 (초). 카메라·입자 보간 전용 — 게임 시간에는 쓰지 않는다. */
  tick(): number {
    const now = performance.now();
    this.dt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    return this.dt;
  }

  /** 매 프레임: 카메라 적용, 배경 입자, 플래시. tick() 뒤에 호출. */
  frame(flashColor: number, flashAlpha: number, bgFlashColor = 0, bgFlashAlpha = 0): void {
    const dt = this.dt;
    const w = this.width;
    const h = this.height;
    const c = this.camera;
    this.world.position.set(w / 2, h / 2);
    this.world.pivot.set(c.x + c.shakeX, c.y + c.shakeY);
    this.world.scale.set(this.baseScale * c.zoom);
    this.world.rotation = (c.rotation * Math.PI) / 180;

    const g = this.moteGfx;
    g.clear();
    for (const m of this.motes) {
      m.x = (m.x + m.vx * dt + 1) % 1;
      m.y = (m.y + m.vy * dt + 1) % 1;
      g.circle(m.x * w, m.y * h, m.r).fill({ color: 0xaab4ff, alpha: m.a });
    }
    this.layoutBg();

    this.flash.clear();
    if (flashAlpha > 0.001) this.flash.rect(0, 0, w, h).fill({ color: flashColor, alpha: flashAlpha });
    this.bgFlash.clear();
    if (bgFlashAlpha > 0.001) this.bgFlash.rect(0, 0, w, h).fill({ color: bgFlashColor, alpha: bgFlashAlpha });
    // 잔상: 트랙 층을 지우지 않고 겹쳐 그림
    if (this.mirrorRT) this.app.renderer.render({ container: this.worldWrap, target: this.mirrorRT, clear: false });
  }

  /** 월드에서 보이는 영역 (컬링용, 회전 고려해 원으로 근사). */
  viewRect(): { cx: number; cy: number; radius: number } {
    const s = this.baseScale * this.camera.zoom;
    return { cx: this.camera.x, cy: this.camera.y, radius: Math.hypot(this.width, this.height) / 2 / s };
  }

  /** 화면 좌표 → 월드 좌표. */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const p = this.world.toLocal({ x: sx, y: sy });
    return { x: p.x, y: p.y };
  }

  clearWorld(): void {
    for (const ch of [...this.world.children]) {
      this.world.removeChild(ch);
    }
  }
}

export const stage = new Stage();

let ambientFn: (() => void) | null = null;
/** 메뉴 화면용: 월드를 비우고 배경 입자만 움직인다. */
export function ambient(on: boolean): void {
  if (ambientFn) {
    stage.app.ticker.remove(ambientFn);
    ambientFn = null;
  }
  if (!on) return;
  stage.clearWorld();
  stage.setBackground(0x0e0f16);
  stage.setBackgroundImage(null);
  stage.setScreenFilters([]);
  stage.camera.shakeX = 0;
  stage.camera.shakeY = 0;
  ambientFn = () => {
    stage.tick();
    stage.frame(0, 0);
  };
  stage.app.ticker.add(ambientFn);
}
