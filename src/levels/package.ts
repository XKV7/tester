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
  if (!jsonName) throw new PackageError(['패키지에서 레벨 파일(level.orbit.json)을 찾을 수 없습니다.']);
  const r = parseLevelJson(strFromU8(flat.get(jsonName)!));
  if (!r.ok) throw new PackageError([`${jsonName}:`, ...r.errors]);
  const warnings = [...r.warnings];
  const song = r.level.settings.songFile;
  if (song && !findFile(flat, song)) warnings.push(`음원 파일 '${song}'을(를) 찾지 못해 합성 비트로 대체합니다.`);
  return { id, level: r.level, files: flat, builtin: false, warnings };
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
export async function download(name: string, data: Uint8Array | string, mime: string): Promise<'saved' | 'declined' | 'failed'> {
  const api = await viewerDownloads();
  if (api) {
    try {
      await api.save({ filename: name, data: typeof data === 'string' ? data : data.slice() });
      return 'saved';
    } catch (e) {
      const code = (e as { code?: string }).code;
      return code === 'declined' ? 'declined' : 'failed';
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
