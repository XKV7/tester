import { demoLevels } from './demos';
import type { LevelPackage } from './package';

/** 세션 동안의 레벨 목록 (내장 데모 + 불러온 레벨). */
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
}

export const library = new Library();
