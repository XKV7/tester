import { compileChart } from '../core/chart';
import { TILE_LEN } from '../core/math';
import { defaultMeta, defaultSettings, FILTER_NAMES, MAX_BPM, MAX_EFFECT_BEATS, MAX_EXTRA_BEATS, MAX_MULTIPLIER, validateLevel } from '../core/level';
import { EASE_NAMES } from '../core/ease';
import type { Action, Decoration, EaseName, LevelData, TrackAppear, TrackDisappear } from '../core/types';

/**
 * 얼음과 불의 춤(.adofai) 레벨 → ORBIT 레벨 변환. 순수 함수.
 *
 * 좌표·방향 규칙이 같다: angleData[i] = 타일 i에서 i+1로 가는 절대 각도(0°=오른쪽, 90°=위),
 * 첫 타일의 진입각 180°, 기본 회전 시계 방향, 두 각도가 같으면 360°(U턴).
 * 그래서 타일 배치·박은 그대로 옮기고, 이벤트는 ORBIT에 있는 것만 옮긴다(없는 연출은 경고로 개수만 알림).
 */

export interface AdofaiResult {
  level: LevelData;
  /** 원본이 가리키는 음원 파일 이름 (없으면 ''). */
  songFile: string;
  warnings: string[];
}

/** pathData 글자 → 절대 각도. 숫자 글자는 이전 방향 기준 상대 회전(정오각형·정칠각형). */
const PATH_CHARS: Record<string, number> = {
  R: 0, p: 15, J: 30, E: 45, T: 60, o: 75, U: 90, q: 105, G: 120, Q: 135, H: 150, W: 165,
  L: 180, x: 195, N: 210, Z: 225, F: 240, V: 255, D: 270, Y: 285, B: 300, C: 315, M: 330, A: 345,
  '!': 999,
};
const RELATIVE_CHARS: Record<string, number> = { '5': 72, '6': -72, '7': 360 / 7, '8': -360 / 7 };
const MIDSPIN = 999;

/**
 * .adofai는 JSON과 비슷하지만 BOM, 끝에 붙은 쉼표(`, }`), 문자열 안 줄바꿈이 흔하다.
 * 문자열 밖의 끝 쉼표만 지우고, 문자열 안 제어 문자는 이스케이프해 JSON.parse에 넘긴다.
 */
export function parseLenientJson(text: string): unknown {
  const s = text.replace(/^﻿/, '');
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') {
        out += c + (s[i + 1] ?? '');
        i++;
      } else if (c === '"') {
        inStr = false;
        out += c;
      } else if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else out += c;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === ',') {
      // 다음 의미 있는 글자가 } 또는 ] 이면 버린다
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] !== '}' && s[j] !== ']') out += c;
    } else out += c;
  }
  return JSON.parse(out);
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** 연출 지속 시간 (박): 0 ~ 한계. */
const dur = (v: unknown, d: number): number => Math.max(0, Math.min(MAX_EFFECT_BEATS, num(v, d)));
const onOff = (v: unknown): boolean => v === true || v === 'Enabled' || v === 'enabled';

/** <color=#fff>…</color> 같은 서식 태그 제거. */
export function stripRichText(s: string): string {
  return s.replace(/<[^>]*>/g, '').trim();
}

/** 'debb7b', '#debb7bff' → '#debb7b'. 잘못된 값이면 null. */
export function adofaiColor(v: unknown): string | null {
  const m = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(str(v).trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}

function mapEase(v: unknown): EaseName | undefined {
  const s = str(v);
  if (!s) return undefined;
  const lc = (s[0].toLowerCase() + s.slice(1)) as EaseName;
  if (EASE_NAMES.includes(lc)) return lc;
  // 없는 종류는 가까운 것으로 (Cubic·Quart·Expo·Circ… → Quad, Bounce → Elastic)
  const m = /^(InOut|In|Out)(\w+)$/.exec(s);
  if (!m) return 'linear';
  const [, dir, kind] = m;
  if (kind === 'Back' || kind === 'Elastic' || kind === 'Bounce') return kind === 'Back' ? 'outBack' : 'outElastic';
  const base = kind === 'Sine' ? 'Sine' : 'Quad';
  return `${dir === 'In' ? 'in' : dir === 'Out' ? 'out' : 'inOut'}${base}` as EaseName;
}

/** 원본의 angleData / pathData → 절대 각도 배열 (999 = 미드스핀). */
function readAngles(raw: Record<string, unknown>, warnings: string[]): number[] {
  if (Array.isArray(raw.angleData)) return raw.angleData.map((v) => num(v, 0));
  const pd = str(raw.pathData);
  const out: number[] = [];
  let prev = 0;
  let unknown = 0;
  for (const ch of pd) {
    let a: number;
    if (ch in PATH_CHARS) a = PATH_CHARS[ch];
    else if (ch in RELATIVE_CHARS) a = (((prev + RELATIVE_CHARS[ch]) % 360) + 360) % 360;
    else {
      unknown++;
      a = prev;
    }
    out.push(a);
    if (a !== MIDSPIN) prev = a;
  }
  if (unknown) warnings.push(`pathData의 알 수 없는 글자 ${unknown}개는 앞 방향으로 대체했습니다.`);
  return out;
}

/** 타일 참조 [n, "ThisTile"|"Start"|"End"] → 절대 타일 번호. */
function tileRef(ref: unknown, floor: number, last: number): number {
  if (!Array.isArray(ref)) return floor;
  const n = Math.round(num(ref[0], 0));
  const base = ref[1] === 'Start' ? 0 : ref[1] === 'End' ? last : floor;
  return Math.max(0, Math.min(last, base + n));
}

/** 원작 AddDecoration / AddText → 장식. 위치 단위: 타일 (× TILE_LEN). */
function decoFrom(e: Record<string, unknown>, floor: number, isText: boolean): Decoration | null {
  const image = str(e.decorationImage).split(/[\\/]/).pop() ?? '';
  const text = isText ? str(e.decText) : '';
  if (!isText && !image) return null;
  const rel = str(e.relativeTo);
  const vec = (v: unknown, d: number): [number, number] => (Array.isArray(v) ? [num(v[0], d), num(v[1], d)] : [d, d]);
  const pos = vec(e.position, 0);
  const d: Decoration = {
    relativeTo: rel === 'Global' ? 'global' : rel === 'Camera' || rel === 'CameraAspect' ? 'camera' : 'tile',
    floor,
    position: [pos[0] * TILE_LEN, pos[1] * TILE_LEN],
  };
  if (isText) {
    d.text = text;
    d.fontSize = 40;
  } else d.image = image;
  const tag = str(e.tag).trim();
  if (tag) d.tag = tag;
  const piv = vec(e.pivotOffset, 0);
  if (piv[0] || piv[1]) d.pivot = [piv[0] * TILE_LEN, piv[1] * TILE_LEN];
  const rot = num(e.rotation, 0);
  if (rot) d.rotation = rot;
  const sc = Array.isArray(e.scale) ? vec(e.scale, 100) : [num(e.scale, 100), num(e.scale, 100)];
  if (sc[0] !== 100 || sc[1] !== 100) d.scale = [sc[0] / 100, sc[1] / 100];
  const c = adofaiColor(e.color);
  if (c && c !== '#ffffff') d.color = c;
  const op = num(e.opacity, 100) / 100;
  if (op !== 1) d.opacity = Math.max(0, Math.min(1, op));
  d.depth = num(e.depth, -1);
  const par = vec(e.parallax, 0);
  if (par[0] || par[1]) d.parallax = [par[0] / 100, par[1] / 100];
  if (e.hideIcon === undefined && (e.visible === false || e.visible === 'Disabled')) d.visible = false;
  return d;
}

export function convertAdofai(text: string): AdofaiResult {
  let raw: unknown;
  try {
    raw = parseLenientJson(text);
  } catch (e) {
    throw new Error(`.adofai 파일을 읽을 수 없습니다: ${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('.adofai 파일 형식이 아닙니다.');
  const r = raw as Record<string, unknown>;
  const warnings: string[] = [];
  const angles = readAngles(r, warnings);
  if (angles.length === 0) throw new Error('.adofai 파일에 타일(angleData / pathData)이 없습니다.');

  // ── 타일: 미드스핀(999)은 '이전 방향의 반대 + Midspin 이벤트'로
  const path: number[] = [];
  const midspins: number[] = [];
  for (let i = 0; i < angles.length; i++) {
    const a = angles[i];
    if (a === MIDSPIN) {
      if (i === 0 || i === angles.length - 1) {
        warnings.push(`${i === 0 ? '첫' : '마지막'} 타일의 미드스핀은 옮길 수 없어 곧은 길로 바꿨습니다.`);
        path.push(i === 0 ? 0 : path[i - 1]);
        continue;
      }
      path.push((path[i - 1] + 180) % 360);
      midspins.push(i);
    } else path.push(((a % 360) + 360) % 360);
  }
  const last = path.length; // 도착 타일 번호

  // ── 설정
  const s = (typeof r.settings === 'object' && r.settings !== null ? r.settings : {}) as Record<string, unknown>;
  const settings = defaultSettings();
  settings.bpm = Math.max(0.001, Math.min(MAX_BPM, num(s.bpm, 100)));
  // 원작 offset = 첫 타일(floor 1)을 누르는 순간. ORBIT offset = 타일 0 시각 → 아래에서 첫 회전만큼 당긴다.
  const firstHit = num(s.offset, 0) / 1000;
  settings.offset = firstHit;
  settings.pitch = Math.max(0.25, Math.min(4, num(s.pitch, 100) / 100));
  settings.volume = Math.max(0, Math.min(1, num(s.volume, 100) / 100));
  settings.countdownTicks = Math.max(0, Math.min(16, Math.round(num(s.countdownTicks, 4))));
  settings.trackColor = adofaiColor(s.trackColor) ?? '#debb7b';
  settings.bgColor = adofaiColor(s.backgroundColor) ?? '#000000';
  settings.startDirection = 'CW';
  const songFile = str(s.songFilename).split(/[\\/]/).pop() ?? '';
  settings.songFile = songFile;

  const meta = defaultMeta();
  meta.title = stripRichText(str(s.song)) || '가져온 레벨';
  meta.artist = stripRichText(str(s.artist)) || '알 수 없음';
  const author = stripRichText(str(s.author));
  meta.author = author ? `원작 맵: ${author}` : '원작 맵 (얼음과 불의 춤)';
  meta.difficulty = Math.max(1, Math.min(10, Math.round(num(s.difficulty, 5))));
  meta.previewStart = Math.max(0, num(s.previewSongStart, 0));

  // ── 이벤트
  const actions: Action[] = midspins.map((floor) => ({ floor, type: 'Midspin' as const }));
  const midSet = new Set(midspins);
  const skipped = new Map<string, number>();
  const approx = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  /** PositionTrack: 해당 타일부터 뒤로 계속 밀리는 정적 위치 (타일 단위). */
  const shift: { floor: number; x: number; y: number }[] = [];

  const decorations: Decoration[] = [];
  const filterSet = new Set(FILTER_NAMES);
  // 장식은 새 버전은 "decorations" 배열, 옛 버전은 actions 안의 AddDecoration/AddText
  const list = [...(Array.isArray(r.actions) ? r.actions : []), ...(Array.isArray(r.decorations) ? r.decorations : [])];
  for (const ev of list) {
    if (typeof ev !== 'object' || ev === null) continue;
    const e = ev as Record<string, unknown>;
    const type = str(e.eventType);
    const floor = Math.round(num(e.floor, type === 'AddDecoration' || type === 'AddText' ? 0 : -1));
    if (floor < 0 || floor > last) continue;
    if (e.active === false) continue;
    // 원작 angleOffset: 타일을 친 뒤 그 각도만큼 돈 다음 (180° = 1박)
    const delay = Math.max(0, num(e.angleOffset, 0)) / 180;
    const vis = (a: Action) => {
      if (delay > 0) a.delay = Math.min(MAX_EFFECT_BEATS, delay);
      actions.push(a);
    };
    switch (type) {
      case 'Twirl':
        actions.push({ floor, type: 'Twirl' });
        break;
      case 'SetSpeed': {
        if (num(e.angleOffset, 0) !== 0) bump(approx, 'SetSpeed(각도 지연)');
        if (str(e.speedType) === 'Multiplier') {
          const m = num(e.bpmMultiplier, 1);
          if (m > 0 && m <= MAX_MULTIPLIER) actions.push({ floor, type: 'SetSpeed', multiplier: m });
          else bump(approx, 'SetSpeed(범위 밖 배율)');
        } else {
          const b = num(e.beatsPerMinute, settings.bpm);
          if (b > 0 && b <= MAX_BPM) actions.push({ floor, type: 'SetSpeed', bpm: b });
          else bump(approx, 'SetSpeed(범위 밖 BPM)');
        }
        break;
      }
      case 'Pause': {
        const b = num(e.duration, 0);
        if (b > 0 && floor < last && !midSet.has(floor)) actions.push({ floor, type: 'Pause', beats: Math.min(MAX_EXTRA_BEATS, b) });
        break;
      }
      case 'Hold': {
        // 원작 Hold의 duration = 추가로 도는 바퀴 수 (1바퀴 = 2박)
        const laps = num(e.duration, 0);
        if (laps > 0 && floor < last && !midSet.has(floor)) actions.push({ floor, type: 'Hold', beats: Math.min(MAX_EXTRA_BEATS, laps * 2) });
        else bump(approx, 'Hold(추가 바퀴 0)');
        break;
      }
      case 'Checkpoint':
        actions.push({ floor, type: 'Checkpoint' });
        break;
      case 'ColorTrack': {
        const c = adofaiColor(e.trackColor);
        if (c) vis({ floor, type: 'RecolorTrack', from: floor, to: last, color: c });
        break;
      }
      case 'RecolorTrack': {
        const c = adofaiColor(e.trackColor);
        if (!c) break;
        const a = tileRef(e.startTile, floor, last);
        const b = tileRef(e.endTile, floor, last);
        vis({ floor, type: 'RecolorTrack', from: Math.min(a, b), to: Math.max(a, b), color: c, duration: dur(e.duration, 0) });
        break;
      }
      case 'MoveCamera': {
        const cam: Action = { floor, type: 'Camera', duration: dur(e.duration, 1) };
        if (e.zoom !== undefined && e.zoom !== null) cam.zoom = Math.max(0.05, Math.min(20, 100 / Math.max(1, num(e.zoom, 100))));
        if (e.rotation !== undefined && e.rotation !== null) cam.rotation = num(e.rotation, 0);
        if (Array.isArray(e.position) && e.position.some((v) => v !== null)) cam.offset = [num(e.position[0], 0) * TILE_LEN, num(e.position[1], 0) * TILE_LEN];
        const ease = mapEase(e.ease);
        if (ease) cam.ease = ease;
        const rel = str(e.relativeTo);
        if (rel === 'Player') cam.relativeTo = 'player';
        else if (rel === 'Tile') {
          cam.relativeTo = 'tile';
          cam.tile = floor;
        } else if (rel === 'Global') cam.relativeTo = 'global';
        else if (rel.startsWith('LastPosition')) cam.relativeTo = 'last';
        vis(cam);
        break;
      }
      case 'Flash': {
        const color = adofaiColor(e.startColor) ?? '#ffffff';
        vis({ floor, type: 'Flash', color, opacity: Math.max(0, Math.min(1, num(e.startOpacity, 100) / 100)), duration: dur(e.duration, 1) });
        break;
      }
      case 'MoveTrack': {
        const a = tileRef(e.startTile, floor, last);
        const b = tileRef(e.endTile, floor, last);
        const mv: Action = { floor, type: 'MoveTrack', from: Math.min(a, b), to: Math.max(a, b), duration: dur(e.duration, 1) };
        if (Array.isArray(e.positionOffset) && e.positionOffset.some((v) => v !== null))
          mv.offset = [num(e.positionOffset[0], 0) * TILE_LEN, num(e.positionOffset[1], 0) * TILE_LEN];
        if (e.rotationOffset !== undefined && e.rotationOffset !== null) mv.rotation = num(e.rotationOffset, 0);
        if (e.opacity !== undefined && e.opacity !== null) mv.opacity = Math.max(0, Math.min(1, num(e.opacity, 100) / 100));
        const sc = Array.isArray(e.scale) ? e.scale[0] : e.scale;
        if (sc !== undefined && sc !== null) mv.scale = Math.max(0, Math.min(100, num(sc, 100) / 100));
        const ease = mapEase(e.ease);
        if (ease) mv.ease = ease;
        vis(mv);
        break;
      }
      case 'PositionTrack': {
        if (onOff(e.editorOnly)) break;
        const p = Array.isArray(e.positionOffset) ? e.positionOffset : [0, 0];
        const x = num(p[0], 0);
        const y = num(p[1], 0);
        if (x || y) shift.push({ floor, x, y });
        break;
      }
      case 'CustomBackground': {
        const c = adofaiColor(e.color);
        const img = str(e.bgImage).split(/[\\/]/).pop() ?? '';
        const mode = str(e.bgDisplayMode);
        const fit = mode === 'Unscaled' ? 'unscaled' : mode === 'Tiled' ? 'tile' : 'cover';
        const tint = adofaiColor(e.imageColor);
        vis({
          floor,
          type: 'Background',
          ...(c ? { color: c } : {}),
          image: img,
          ...(img ? { fit, opacity: 1, ...(tint && tint !== '#ffffff' ? { tint } : {}) } : {}),
        });
        break;
      }
      case 'SetFilter': {
        const name = str(e.filter);
        if (!name) break;
        if (!filterSet.has(name)) bump(skipped, `필터 ${name}`);
        const on = onOff(e.enabled);
        vis({
          floor,
          type: 'Filter',
          filter: name,
          enabled: on,
          intensity: Math.max(0, Math.min(100, num(e.intensity, 100) / 100)),
          ...(onOff(e.disableOthers) ? { exclusive: true } : {}),
          ...(num(e.duration, 0) > 0 ? { duration: dur(e.duration, 0) } : {}),
        });
        break;
      }
      case 'Bloom':
        vis({
          floor,
          type: 'Bloom',
          enabled: onOff(e.enabled),
          intensity: Math.max(0, Math.min(100, num(e.intensity, 100) / 100)),
          threshold: Math.max(0, Math.min(1, num(e.threshold, 50) / 100)),
          ...(adofaiColor(e.color) ? { color: adofaiColor(e.color)! } : {}),
        });
        break;
      case 'ShakeScreen':
        vis({
          floor,
          type: 'Shake',
          duration: dur(e.duration, 1),
          strength: Math.max(0, Math.min(100, num(e.strength, 100) / 100)),
          frequency: Math.max(0, Math.min(1000, (num(e.intensity, 100) / 100) * 15)),
          fadeOut: e.fadeOut === undefined ? true : onOff(e.fadeOut),
        });
        break;
      case 'AnimateTrack': {
        const ap: Record<string, TrackAppear> = {
          None: 'none', Fade: 'fade', Grow: 'grow', Grow_Spin: 'spin', Extend: 'extend', Drop: 'drop', Rise: 'rise',
          Assemble: 'scatter', Assemble_Far: 'scatter', Assemble_Scatter: 'scatter', Scatter: 'scatter', Scatter_Far: 'scatter',
        };
        const dp: Record<string, TrackDisappear> = {
          None: 'none', Fade: 'fade', Shrink: 'shrink', Shrink_Spin: 'spin', Scatter: 'scatter', Scatter_Far: 'scatter', Retract: 'retract', Rise: 'fade', Drop: 'fade',
        };
        const a: Action = { floor, type: 'TrackAnim' };
        if (e.trackAnimation !== undefined) a.appear = ap[str(e.trackAnimation)] ?? 'fade';
        if (e.beatsAhead !== undefined) a.beatsAhead = Math.max(0, Math.min(MAX_EFFECT_BEATS, num(e.beatsAhead, 3)));
        if (e.trackDisappearAnimation !== undefined) a.disappear = dp[str(e.trackDisappearAnimation)] ?? 'fade';
        if (e.beatsBehind !== undefined) a.beatsBehind = Math.max(0, Math.min(MAX_EFFECT_BEATS, num(e.beatsBehind, 4)));
        actions.push(a);
        break;
      }
      case 'AddDecoration':
      case 'AddText': {
        const d = decoFrom(e, floor, type === 'AddText');
        if (d) decorations.push(d);
        break;
      }
      case 'MoveDecorations': {
        const tag = str(e.tag).trim();
        if (!tag) break;
        const a: Action = { floor, type: 'MoveDecorations', tag, duration: dur(e.duration, 1) };
        if (Array.isArray(e.positionOffset) && e.positionOffset.some((v) => v !== null))
          a.offset = [num(e.positionOffset[0], 0) * TILE_LEN, num(e.positionOffset[1], 0) * TILE_LEN];
        if (e.rotationOffset !== undefined && e.rotationOffset !== null) a.rotation = num(e.rotationOffset, 0);
        if (e.scale !== undefined && e.scale !== null) {
          const sc = Array.isArray(e.scale) ? e.scale : [e.scale, e.scale];
          a.scale = [num(sc[0], 100) / 100, num(sc[1] ?? sc[0], 100) / 100];
        }
        const c = adofaiColor(e.color);
        if (c) a.color = c;
        if (e.opacity !== undefined && e.opacity !== null) a.opacity = Math.max(0, Math.min(1, num(e.opacity, 100) / 100));
        if (e.visible !== undefined) a.visible = onOff(e.visible);
        if (str(e.decorationImage)) a.image = str(e.decorationImage).split(/[\\/]/).pop();
        const ease = mapEase(e.ease);
        if (ease) a.ease = ease;
        vis(a);
        break;
      }
      case 'MultiPlanet':
      case 'FreeRoam':
      case 'FreeRoamTwirl':
      case 'FreeRoamRemove':
      case 'SetPlanetRotation':
      case 'ScaleRadius':
        bump(approx, type);
        break;
      default:
        bump(skipped, type || '(이름 없음)');
    }
  }

  // PositionTrack → 타일마다 누적 위치를 구해, 같은 위치가 이어지는 구간마다 즉시 적용되는 MoveTrack (첫 타일에서)
  if (shift.length) {
    const ox = new Float64Array(last + 1);
    const oy = new Float64Array(last + 1);
    for (const sh of shift)
      for (let f = sh.floor; f <= last; f++) {
        ox[f] += sh.x;
        oy[f] += sh.y;
      }
    let from = 0;
    for (let f = 1; f <= last + 1; f++) {
      if (f <= last && ox[f] === ox[from] && oy[f] === oy[from]) continue;
      if (ox[from] || oy[from]) actions.push({ floor: 0, type: 'MoveTrack', from, to: f - 1, offset: [ox[from] * TILE_LEN, oy[from] * TILE_LEN], duration: 0 });
      from = f;
    }
  }

  actions.sort((a, b) => a.floor - b.floor);

  const ignoredDecor = 0;
  if (approx.size)
    warnings.push(
      `원작과 다르게 동작할 수 있는 이벤트: ${[...approx].map(([k, n]) => `${k} ${n}개`).join(', ')}. ` +
        (approx.has('MultiPlanet') || approx.has('FreeRoam') ? '행성 3개·자유 이동 구간은 박이 원작과 다릅니다.' : ''),
    );
  if (skipped.size || ignoredDecor)
    warnings.push(
      `ORBIT에 없는 연출은 뺐습니다: ${[...skipped].map(([k, n]) => `${k} ${n}개`).join(', ')}${ignoredDecor ? `${skipped.size ? ', ' : ''}장식 ${ignoredDecor}개` : ''}.`,
    );

  let level: LevelData = { version: 1, meta, settings, path, actions, ...(decorations.length ? { decorations } : {}) };
  // 안전망: 그래도 검증을 못 넘는 이벤트가 있으면 그 이벤트만 빼고 알린다 (레벨 전체를 거부하지 않게)
  for (let pass = 0; pass < 3; pass++) {
    const v = validateLevel(level);
    if (v.ok) break;
    const bad = new Set<number>();
    for (const err of v.errors) {
      const m = /^actions\[(\d+)\]/.exec(err);
      if (m) bad.add(Number(m[1]));
    }
    if (!bad.size) throw new Error(`변환한 레벨이 올바르지 않습니다: ${v.errors.slice(0, 3).join(' / ')}`);
    warnings.push(`옮길 수 없는 이벤트 ${bad.size}개를 뺐습니다 (예: ${v.errors[0]}).`);
    level = { ...level, actions: level.actions.filter((_, i) => !bad.has(i)) };
  }
  // 첫 회전(타일 0 → 1) 시간만큼 앞당겨, 타일 1이 원작 offset 시각에 오게 한다
  const first = compileChart(level).tiles[0].duration;
  settings.offset = Math.max(-60, Math.min(3600, Math.round((firstHit - first) * 10000) / 10000));
  return { level, songFile, warnings };
}
