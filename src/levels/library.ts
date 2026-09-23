import { demoLevels } from './demos';
import { packageFromFiles, type LevelPackage } from './package';

/** 세션 동안의 레벨 목록 (내장 데모 + 함께 배포된 레벨 + 불러온 레벨). */
class Library {
  readonly items: LevelPackage[] = demoLevels().map((d) => ({
    id: d.id,
    level: d.level,
    files: new Map(),
    builtin: true,
    warnings: [],
  }));

  add(pkg: LevelPackage): void {
    const i = this.items.findIndex((p) => p.id === pkg.id);
    if (i >= 0) this.items[i] = pkg;
    else this.items.push(pkg);
  }

  get(id: string): LevelPackage | undefined {
    return this.items.find((p) => p.id === id);
  }

  /**
   * `levels/index.json`(폴더 이름 배열)에 적힌 레벨 폴더를 불러온다.
   * 각 폴더: level.orbit.json + 음원(+ 배경 이미지). 목록이 없거나 실패하면 조용히 넘어간다.
   */
  async loadBundled(base = 'levels/'): Promise<string[]> {
    const errors: string[] = [];
    let names: unknown;
    try {
      const res = await fetch(base + 'index.json', { cache: 'no-cache' });
      if (!res.ok) return errors;
      names = await res.json();
    } catch {
      return errors;
    }
    if (!Array.isArray(names)) return [`${base}index.json은 폴더 이름 배열이어야 합니다.`];
    const loaded: (LevelPackage | null)[] = await Promise.all(
      names.map(async (name): Promise<LevelPackage | null> => {
        if (typeof name !== 'string' || !/^[\w\-가-힣. ]+$/.test(name)) {
          errors.push(`잘못된 폴더 이름: ${String(name)}`);
          return null;
        }
        try {
          const dir = `${base}${encodeURIComponent(name)}/`;
          const json = await fetch(dir + 'level.orbit.json');
          if (!json.ok) throw new Error(`${dir}level.orbit.json을 찾을 수 없습니다.`);
          const files = new Map<string, Uint8Array>([['level.orbit.json', new Uint8Array(await json.arrayBuffer())]]);
          const pkg = packageFromFiles(files, `bundled-${name}`);
          const extra = [pkg.level.settings.songFile, ...pkg.level.actions.flatMap((a) => (a.type === 'Background' && a.image ? [a.image] : []))];
          for (const f of extra.filter(Boolean)) {
            const r = await fetch(dir + encodeURIComponent(f));
            if (r.ok) pkg.files.set(f, new Uint8Array(await r.arrayBuffer()));
            else errors.push(`${name}: '${f}' 파일이 없어 합성 비트로 대체합니다.`);
          }
          pkg.warnings = [];
          pkg.builtin = true;
          return pkg;
        } catch (e) {
          errors.push(`${name}: ${(e as Error).message}`);
          return null;
        }
      }),
    );
    // index.json 순서대로 추가
    for (const pkg of loaded) if (pkg) this.add(pkg);
    return errors;
  }
}

export const library = new Library();
