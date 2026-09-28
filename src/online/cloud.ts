import type { FirebaseApp } from 'firebase/app';
import type { Auth, User } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import { parseLevelJson, serializeLevel } from '../core/level';
import { findFile, type LevelPackage } from '../levels/package';
import { firebaseConfig, onlineAvailable } from './config';

/**
 * Firebase 연동 (온라인 레벨·음원·기록·설정). firebase SDK는 처음 쓸 때 동적으로 불러온다.
 *
 * Firestore 구조 (규칙: firestore.rules)
 *   levels/{id}            레벨 정보 + 레벨 JSON 문자열, ownerUid, ready
 *   levels/{id}/chunks/{k}  음원·이미지 바이트를 750KB 조각으로 (Storage 없이 무료 요금제로 동작)
 *   scores/{levelKey}__{uid} 레벨별 한 사람의 최고 정확도 (더 높을 때만 갱신)
 *   users/{uid}            닉네임, 설정, 최고 기록 (본인만 읽기·쓰기)
 */

export const CHUNK_BYTES = 750_000;
/** 올릴 수 있는 파일 하나의 최대 크기. */
export const MAX_FILE_BYTES = 15 * 1024 * 1024;

export interface CloudLevel {
  id: string;
  title: string;
  artist: string;
  author: string;
  ownerUid: string;
  bpm: number;
  tiles: number;
  difficulty: number;
  hasSong: boolean;
  bytes: number;
  createdAt: number;
}

export interface ScoreRow {
  uid: string;
  name: string;
  acc: number;
  at: number;
}

interface Sdk {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  fa: typeof import('firebase/auth');
  fs: typeof import('firebase/firestore');
}

let sdkPromise: Promise<Sdk> | null = null;

function sdk(): Promise<Sdk> {
  if (!onlineAvailable()) return Promise.reject(new Error('온라인 기능을 쓸 수 없는 환경입니다.'));
  sdkPromise ??= (async () => {
    const [{ initializeApp }, fa, fs] = await Promise.all([import('firebase/app'), import('firebase/auth'), import('firebase/firestore')]);
    const app = initializeApp(firebaseConfig!);
    const auth = fa.getAuth(app);
    const db = fs.getFirestore(app);
    // 로컬 시험용: VITE_FIREBASE_EMULATOR=1 이면 에뮬레이터에 연결
    if ((import.meta.env as Record<string, string | undefined>).VITE_FIREBASE_EMULATOR === '1') {
      fa.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      fs.connectFirestoreEmulator(db, '127.0.0.1', 8080);
      // 자동 시험용 로그인 (에뮬레이터 빌드에서만 존재)
      (window as unknown as Record<string, unknown>).__orbitTestSignIn = async (name: string) => {
        const c = await fa.signInAnonymously(auth);
        await fa.updateProfile(c.user, { displayName: name });
      };
    }
    return { app, auth, db, fa, fs };
  })();
  return sdkPromise;
}

// ───────────────────────── 로그인 ─────────────────────────

export interface Profile {
  uid: string;
  name: string;
}

let me: Profile | null = null;
const listeners = new Set<(p: Profile | null) => void>();

export function currentProfile(): Profile | null {
  return me;
}

/** 로그인 상태 변화를 듣는다. 등록 즉시 현재 상태로 한 번 호출. 해제 함수 반환. */
export function onProfile(fn: (p: Profile | null) => void): () => void {
  listeners.add(fn);
  fn(me);
  return () => listeners.delete(fn);
}

function emit(): void {
  for (const fn of listeners) fn(me);
}

/** 앱 시작 시 호출: 로그인 유지·리디렉트 결과를 반영하고 설정을 동기화한다. */
export async function initOnline(onSignedIn: (uid: string) => Promise<void>): Promise<void> {
  if (!onlineAvailable()) return;
  const { auth, fa } = await sdk();
  fa.getRedirectResult(auth).catch(() => undefined);
  fa.onAuthStateChanged(auth, (u: User | null) => {
    void (async () => {
      if (!u) {
        me = null;
        emit();
        return;
      }
      me = { uid: u.uid, name: await loadNickname(u) };
      emit();
      try {
        await onSignedIn(u.uid);
      } catch (e) {
        console.warn('[ORBIT] 설정 동기화 실패', e);
      }
    })();
  });
}

export async function signIn(): Promise<void> {
  const { auth, fa } = await sdk();
  const provider = new fa.GoogleAuthProvider();
  try {
    await fa.signInWithPopup(auth, provider);
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    // 팝업이 막힌 브라우저(일부 모바일·앱 내 브라우저)는 페이지 이동 방식으로
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') await fa.signInWithRedirect(auth, provider);
    else if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') throw e;
  }
}

export async function signOut(): Promise<void> {
  const { auth, fa } = await sdk();
  await fa.signOut(auth);
}

async function loadNickname(u: User): Promise<string> {
  const { db, fs } = await sdk();
  try {
    const snap = await fs.getDoc(fs.doc(db, 'users', u.uid));
    const n = snap.exists() ? (snap.data().nickname as string | undefined) : undefined;
    if (n) return n;
  } catch {
    /* 첫 로그인 */
  }
  return cleanName(u.displayName || '플레이어');
}

export function cleanName(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 20) || '플레이어';
}

export async function setNickname(name: string): Promise<void> {
  if (!me) throw new Error('로그인이 필요합니다.');
  const { db, fs } = await sdk();
  const n = cleanName(name);
  await fs.setDoc(fs.doc(db, 'users', me.uid), { nickname: n }, { merge: true });
  me = { ...me, name: n };
  emit();
}

// ───────────────────────── 설정·기록 동기화 ─────────────────────────

export interface UserData {
  settings?: Record<string, unknown>;
  settingsAt?: number;
  best?: Record<string, number>;
}

export async function loadUserData(uid: string): Promise<UserData> {
  const { db, fs } = await sdk();
  const snap = await fs.getDoc(fs.doc(db, 'users', uid));
  return snap.exists() ? (snap.data() as UserData) : {};
}

export async function saveUserData(uid: string, data: UserData): Promise<void> {
  const { db, fs } = await sdk();
  await fs.setDoc(fs.doc(db, 'users', uid), data, { merge: true });
}

// ───────────────────────── 온라인 레벨 ─────────────────────────

/** 올릴 파일: 레벨이 참조하는 음원·배경 이미지. */
export function referencedFiles(pkg: LevelPackage): { name: string; data: Uint8Array }[] {
  const names = [pkg.level.settings.songFile, ...pkg.level.actions.flatMap((a) => (a.type === 'Background' && a.image ? [a.image] : []))];
  const out: { name: string; data: Uint8Array }[] = [];
  for (const n of names) {
    if (!n || out.some((o) => o.name === n)) continue;
    const d = findFile(pkg.files, n);
    if (d) out.push({ name: n, data: d });
  }
  return out;
}

export async function uploadLevel(pkg: LevelPackage, files: { name: string; data: Uint8Array }[], onProgress?: (r: number) => void): Promise<string> {
  if (!me) throw new Error('로그인이 필요합니다.');
  for (const f of files) if (f.data.length > MAX_FILE_BYTES) throw new Error(`'${f.name}'이(가) 너무 큽니다 (${(f.data.length / 1048576).toFixed(1)}MB, 최대 15MB).`);
  const { db, fs } = await sdk();
  const lv = pkg.level;
  const ref = fs.doc(fs.collection(db, 'levels'));
  const total = files.reduce((s, f) => s + f.data.length, 0);
  await fs.setDoc(ref, {
    title: (lv.meta.title || '제목 없음').slice(0, 100),
    artist: (lv.meta.artist || '').slice(0, 100),
    author: me.name,
    ownerUid: me.uid,
    bpm: lv.settings.bpm,
    tiles: lv.path.length + 1,
    difficulty: lv.meta.difficulty,
    hasSong: files.some((f) => f.name === lv.settings.songFile),
    bytes: total,
    files: files.map((f) => ({ name: f.name, size: f.data.length, chunks: Math.max(1, Math.ceil(f.data.length / CHUNK_BYTES)) })),
    levelJson: serializeLevel(lv),
    ready: false,
    createdAt: fs.serverTimestamp(),
  });
  let done = 0;
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    const n = Math.max(1, Math.ceil(f.data.length / CHUNK_BYTES));
    for (let i = 0; i < n; i++) {
      const part = f.data.subarray(i * CHUNK_BYTES, Math.min(f.data.length, (i + 1) * CHUNK_BYTES));
      await fs.setDoc(fs.doc(db, 'levels', ref.id, 'chunks', `${fi}_${i}`), { f: fi, i, data: fs.Bytes.fromUint8Array(part) });
      done += part.length;
      onProgress?.(total ? done / total : 1);
    }
  }
  await fs.updateDoc(ref, { ready: true });
  onProgress?.(1);
  return ref.id;
}

export async function listLevels(max = 100): Promise<CloudLevel[]> {
  const { db, fs } = await sdk();
  const q = fs.query(fs.collection(db, 'levels'), fs.orderBy('createdAt', 'desc'), fs.limit(max));
  const snap = await fs.getDocs(q);
  const out: CloudLevel[] = [];
  snap.forEach((d) => {
    const x = d.data();
    if (!x.ready) return;
    out.push({
      id: d.id,
      title: String(x.title ?? ''),
      artist: String(x.artist ?? ''),
      author: String(x.author ?? ''),
      ownerUid: String(x.ownerUid ?? ''),
      bpm: Number(x.bpm) || 0,
      tiles: Number(x.tiles) || 0,
      difficulty: Number(x.difficulty) || 1,
      hasSong: !!x.hasSong,
      bytes: Number(x.bytes) || 0,
      createdAt: x.createdAt?.toMillis?.() ?? 0,
    });
  });
  return out;
}

export const cloudPackageId = (docId: string) => `cloud-${docId}`;

export async function downloadLevel(docId: string, onProgress?: (r: number) => void): Promise<LevelPackage> {
  const { db, fs } = await sdk();
  const snap = await fs.getDoc(fs.doc(db, 'levels', docId));
  if (!snap.exists()) throw new Error('레벨이 삭제되었습니다.');
  const x = snap.data();
  const r = parseLevelJson(String(x.levelJson ?? ''));
  if (!r.ok) throw new Error(`레벨 데이터가 손상되었습니다: ${r.errors[0] ?? ''}`);
  const metas = (x.files ?? []) as { name: string; size: number; chunks: number }[];
  const chunks = await fs.getDocs(fs.collection(db, 'levels', docId, 'chunks'));
  const parts = new Map<number, Uint8Array[]>();
  chunks.forEach((c) => {
    const d = c.data();
    const arr = parts.get(d.f) ?? [];
    arr[d.i] = (d.data as import('firebase/firestore').Bytes).toUint8Array();
    parts.set(d.f, arr);
  });
  onProgress?.(1);
  const files = new Map<string, Uint8Array>();
  metas.forEach((m, fi) => {
    const arr = parts.get(fi) ?? [];
    if (arr.length !== m.chunks || arr.some((a) => !a)) return; // 일부 조각이 없으면 그 파일은 건너뜀 (합성 비트)
    const out = new Uint8Array(m.size);
    let o = 0;
    for (const a of arr) {
      out.set(a, o);
      o += a.length;
    }
    files.set(m.name.split('/').pop() ?? m.name, out);
  });
  const warnings = [...r.warnings];
  if (r.level.settings.songFile && !findFile(files, r.level.settings.songFile)) warnings.push('음원을 받지 못해 합성 비트로 대체합니다.');
  return { id: cloudPackageId(docId), level: r.level, files, builtin: false, warnings };
}

export async function deleteLevel(docId: string): Promise<void> {
  const { db, fs } = await sdk();
  const chunks = await fs.getDocs(fs.collection(db, 'levels', docId, 'chunks'));
  for (const c of chunks.docs) await fs.deleteDoc(c.ref);
  await fs.deleteDoc(fs.doc(db, 'levels', docId));
}

// ───────────────────────── 기록·순위 ─────────────────────────

/** 순위를 매길 수 있는 레벨 키 (내장·포함·온라인 레벨). 세션마다 새로 만든 레벨은 null. */
export function rankKey(pkg: LevelPackage): string | null {
  if (pkg.id.startsWith('cloud-') || pkg.id.startsWith('bundled-') || pkg.builtin) return pkg.id.replace(/[/\s]/g, '_').slice(0, 200);
  return null;
}

export async function submitScore(key: string, acc: number): Promise<boolean> {
  if (!me) return false;
  const { db, fs } = await sdk();
  const ref = fs.doc(db, 'scores', `${key}__${me.uid}`);
  const cur = await fs.getDoc(ref);
  const prev = cur.exists() ? Number(cur.data().acc) : -1;
  const a = Math.round(acc * 100) / 100;
  if (a <= prev) return false;
  await fs.setDoc(ref, { levelKey: key, uid: me.uid, name: me.name, acc: a, at: fs.serverTimestamp() });
  return true;
}

export async function topScores(key: string, n = 20): Promise<ScoreRow[]> {
  const { db, fs } = await sdk();
  // 복합 색인 없이: 레벨로만 걸러 받아 정렬 (레벨당 기록 수는 많지 않다)
  const snap = await fs.getDocs(fs.query(fs.collection(db, 'scores'), fs.where('levelKey', '==', key), fs.limit(500)));
  const rows: ScoreRow[] = [];
  snap.forEach((d) => {
    const x = d.data();
    rows.push({ uid: String(x.uid), name: String(x.name ?? ''), acc: Number(x.acc) || 0, at: x.at?.toMillis?.() ?? 0 });
  });
  rows.sort((a, b) => b.acc - a.acc || a.at - b.at);
  return rows.slice(0, n);
}
