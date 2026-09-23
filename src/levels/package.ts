import { strFromU8, unzipSync, zipSync, strToU8 } from 'fflate';
import { compileChart } from '../core/chart';
import { parseLevelJson, serializeLevel } from '../core/level';
import type { LevelData } from '../core/types';
import { audio } from '../audio/engine';
import { synthBeatTrack } from '../audio/beatTrack';

/** 레벨 패키지: 레벨 JSON + 음원 + 부가 파일. */
export interface LevelPackage {
  id: string;
  level: LevelData;
  /** 파일 이름 → 바이트 */
  files: Map<string, Uint8Array>;
  builtin: boolean;
  /** 디코딩된 음원 (캐시). */
  buffer?: AudioBuffer;
  /** 음원이 없어 합성 비트를 쓰는지. */
  synthesized?: boolean;
  warnings: string[];
}

export class PackageError extends Error {
  constructor(public readonly details: string[]) {
    super(details.join('\n'));
  }
}

let idSeq = 0;
export function newPackageId(prefix = 'user'): string {
  return `${prefix}-${Date.now().toString(36)}-${(idSeq++).toString(36)}`;
}

const lower = (s: string) => s.toLowerCase();
const baseName = (p: string) => p.split('/').pop() ?? p;

/** 파일 맵에서 레벨 JSON을 찾아 패키지 생성. */
export function packageFromFiles(files: Map<string, Uint8Array>, id = newPackageId()): LevelPackage {
  // 경로 앞 공통 폴더 제거
  const flat = new Map<string, Uint8Array>();
  for (const [k, v] of files) {
    if (k.endsWith('/') || k.includes('__MACOSX')) continue;
    flat.set(baseName(k), v);
  }
  const names = [...flat.keys()];
  const jsonName =
    names.find((n) => lower(n) === 'level.orbit.json') ??
    names.find((n) => lower(n).endsWith('.orbit.json')) ??
    names.find((n) => lower(n).endsWith('.json'));
  if (!jsonName) throw new PackageError(['패키지에서 레벨 파일(level.orbit.json)을 찾을 수 없습니다.', '음원이나 동영상만 있다면 "음원으로 레벨 만들기"를 쓰세요.']);
  const r = parseLevelJson(strFromU8(flat.get(jsonName)!));
  if (!r.ok) throw new PackageError([`${jsonName}:`, ...r.errors]);
  const warnings = [...r.warnings];
  const song = r.level.settings.songFile;
  if (song && !findFile(flat, song)) warnings.push(`음원 파일 '${song}'을(를) 찾지 못해 합성 비트로 대체합니다.`);
  return { id, level: r.level, files: flat, builtin: false, warnings };
}

/** 음원 파일 하나 → 자동 생성 레벨 패키지. 박을 찾지 못하면 PackageError. */
export async function packageFromSong(file: File, difficulty: 'easy' | 'normal' | 'hard'): Promise<{ pkg: LevelPackage; summary: string }> {
  const { autoChart } = await import('../core/autochart');
  const { toMono } = await import('../audio/mono');
  const data = new Uint8Array(await file.arrayBuffer());
  let buf: AudioBuffer;
  try {
    buf = await audio().decode(data.buffer.slice(0) as ArrayBuffer);
  } catch {
    throw new PackageError([decodeErrorMessage(file.name)]);
  }
  const title = file.name.replace(/\.[^.]+$/, '');
  const r = autoChart(toMono(buf), buf.sampleRate, { difficulty, title, songFile: file.name });
  if (!r) throw new PackageError([`${file.name}: 박을 찾지 못했습니다. 너무 짧거나(8박 미만) 박이 뚜렷하지 않은 곡입니다.`, '에디터에서 BPM을 직접 맞춘 뒤 녹화 모드로 만들 수 있습니다.']);
  const pkg: LevelPackage = {
    id: newPackageId('auto'),
    level: r.level,
    files: new Map([[file.name, data]]),
    builtin: false,
    warnings: [],
    buffer: buf,
    synthesized: false,
  };
  return { pkg, summary: `${r.bpm} BPM · 타일 ${r.tiles}개 · 회전 반전 ${r.twirls}개` };
}

/**
 * 곡으로 고를 수 있는 파일. 동영상은 오디오 트랙만 디코딩해서 쓴다 (화면에는 나오지 않음).
 * 브라우저가 컨테이너·코덱을 지원해야 한다 — mp4(AAC)·webm(Opus/Vorbis)은 대부분 됨, mov는 브라우저에 따라 다름.
 */
export const SONG_ACCEPT =
  'audio/*,video/mp4,video/webm,video/quicktime,video/x-matroska,.mp3,.wav,.ogg,.oga,.opus,.m4a,.aac,.flac,.mp4,.m4v,.webm,.mkv,.mov';

export const PACKAGE_ACCEPT = `.zip,.json,image/*,${SONG_ACCEPT}`;

/** 음원 선택용: 음원·동영상 + 음원을 담은 zip. */
export const SONG_OR_ZIP_ACCEPT = `${SONG_ACCEPT},.zip,application/zip`;

const VIDEO_EXT = /\.(mp4|m4v|webm|mkv|mov)$/i;

/** 디코딩 실패 안내 문구. */
export function decodeErrorMessage(name: string): string {
  return VIDEO_EXT.test(name)
    ? `${name}: 동영상에서 소리를 꺼낼 수 없습니다. 소리가 없는 영상이거나 이 브라우저가 지원하지 않는 코덱입니다. mp3로 바꾸거나 크롬·엣지에서 시도해 보세요.`
    : `${name}: 이 브라우저에서 재생할 수 없는 형식입니다. mp3나 wav로 바꿔 주세요.`;
}

const SONG_EXT = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|mp4|m4v|webm|mkv|mov)$/i;

/** zip 안에 음원/동영상 하나만 들어 있으면 그 파일을 꺼낸다 (mp3를 zip으로 저장한 경우 등). 레벨 파일이 들어 있거나 zip이 아니면 null. */
export async function songFromZip(file: File): Promise<File | null> {
  if (!lower(file.name).endsWith('.zip')) return null;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new PackageError([`${file.name}: zip 파일을 열 수 없습니다.`]);
  }
  const names = Object.keys(entries).filter((n) => !n.endsWith('/') && !n.includes('__MACOSX'));
  if (names.some((n) => lower(n).endsWith('.json'))) return null;
  const song = names.find((n) => SONG_EXT.test(n));
  if (!song) throw new PackageError([`${file.name}: zip 안에 음원 파일이 없습니다.`]);
  return new File([entries[song] as Uint8Array<ArrayBuffer>], baseName(song));
}

export function findFile(files: Map<string, Uint8Array>, name: string): Uint8Array | undefined {
  if (!name) return undefined;
  const b = baseName(name);
  if (files.has(b)) return files.get(b);
  for (const [k, v] of files) if (lower(k) === lower(b)) return v;
  return undefined;
}

/** 사용자가 고른 File 목록(zip, json, 폴더 내용) → 패키지. */
export async function packageFromFileList(list: FileList | File[]): Promise<LevelPackage> {
  const arr = [...list];
  if (arr.length === 0) throw new PackageError(['선택된 파일이 없습니다.']);
  const files = new Map<string, Uint8Array>();
  for (const f of arr) {
    const data = new Uint8Array(await f.arrayBuffer());
    if (lower(f.name).endsWith('.zip')) {
      let entries: Record<string, Uint8Array>;
      try {
        entries = unzipSync(data);
      } catch (e) {
        throw new PackageError([`zip 파일을 열 수 없습니다: ${(e as Error).message}`]);
      }
      for (const [k, v] of Object.entries(entries)) files.set(k, v);
    } else {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      files.set(rel, data);
    }
  }
  return packageFromFiles(files);
}

/** 음원 디코딩 (없거나 실패하면 합성 비트). */
export async function loadPackageAudio(pkg: LevelPackage): Promise<AudioBuffer> {
  if (pkg.buffer) return pkg.buffer;
  const eng = audio();
  const data = findFile(pkg.files, pkg.level.settings.songFile);
  if (data) {
    try {
      pkg.buffer = await eng.decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      pkg.synthesized = false;
      return pkg.buffer;
    } catch {
      pkg.warnings.push('음원을 디코딩할 수 없어 합성 비트로 대체합니다.');
    }
  }
  const sr = eng.ctx.sampleRate;
  pkg.buffer = eng.bufferFromSamples(synthBeatTrack(compileChart(pkg.level), sr), sr);
  pkg.synthesized = true;
  return pkg.buffer;
}

/** 레벨 변경 시 합성 음원 캐시 무효화. */
export function invalidateSynth(pkg: LevelPackage): void {
  if (pkg.synthesized) pkg.buffer = undefined;
}

export function exportZip(pkg: LevelPackage): Uint8Array {
  const entries: Record<string, Uint8Array> = { 'level.orbit.json': strToU8(serializeLevel(pkg.level)) };
  const song = pkg.level.settings.songFile;
  const songData = findFile(pkg.files, song);
  if (song && songData) entries[baseName(song)] = songData;
  for (const a of pkg.level.actions) {
    if (a.type === 'Background' && a.image) {
      const d = findFile(pkg.files, a.image);
      if (d) entries[baseName(a.image)] = d;
    }
  }
  return zipSync(entries, { level: 6 });
}

interface DownloadsApi {
  save(req: { filename: string; data: string | Blob | ArrayBuffer | ArrayBufferView }): Promise<unknown>;
}

/** 임베드 뷰어가 제공하는 다운로드 기능 (없으면 null). */
async function viewerDownloads(): Promise<DownloadsApi | null> {
  const c = (window as unknown as { claude?: { use?: (n: string) => Promise<unknown> } }).claude;
  if (!c || typeof c.use !== 'function') return null;
  try {
    return ((await c.use('downloads')) as DownloadsApi | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * 파일 저장. 다운로드가 막힌 임베드 뷰어에서는 뷰어의 저장 확인 창을 쓰고,
 * 일반 브라우저에서는 링크 다운로드. 결과: 'saved' | 'declined' | 'failed'.
 */
export type SaveResult = 'saved' | 'saved-zip' | 'declined' | 'failed';

export async function download(name: string, data: Uint8Array | string, mime: string): Promise<SaveResult> {
  const api = await viewerDownloads();
  if (api) {
    try {
      await api.save({ filename: name, data: typeof data === 'string' ? data : data.slice() });
      return 'saved';
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'declined') return 'declined';
      // 뷰어가 허용하지 않는 확장자(mp3 등) → zip으로 감싸 다시 시도
      if (code === 'rejected_extension' && !lower(name).endsWith('.zip')) {
        const bytes = typeof data === 'string' ? strToU8(data) : data;
        const zipped = zipSync({ [baseName(name)]: bytes }, { level: 0 });
        try {
          await api.save({ filename: name.replace(/\.[^.]+$/, '') + '.zip', data: zipped });
          return 'saved-zip';
        } catch (e2) {
          return (e2 as { code?: string }).code === 'declined' ? 'declined' : 'failed';
        }
      }
      return 'failed';
    }
  }
  const blob = new Blob([typeof data === 'string' ? data : (data as Uint8Array<ArrayBuffer>)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return 'saved';
}

/** 패키지 내 이미지 → object URL (캐시). */
const urlCache = new WeakMap<Uint8Array, string>();
export function fileUrl(pkg: LevelPackage, name: string): string | null {
  const d = findFile(pkg.files, name);
  if (!d) return null;
  let u = urlCache.get(d);
  if (!u) {
    const ext = lower(name).split('.').pop() ?? '';
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
    u = URL.createObjectURL(new Blob([d as Uint8Array<ArrayBuffer>], { type: mime }));
    urlCache.set(d, u);
  }
  return u;
}
