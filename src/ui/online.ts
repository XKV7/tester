import { findFile, loadPackageAudio, type LevelPackage } from '../levels/package';
import {
  cleanName,
  currentProfile,
  deleteLevel,
  downloadLevel,
  listLevels,
  MAX_FILE_BYTES,
  onProfile,
  rankKey,
  referencedFiles,
  setNickname,
  signIn,
  signOut,
  topScores,
  uploadLevel,
  type CloudLevel,
} from '../online/cloud';
import { onlineAvailable } from '../online/config';
import { alertBox, confirmBox, h, stars, toast } from './dom';

export { onlineAvailable };

function errText(e: unknown): string {
  const code = (e as { code?: string }).code ?? '';
  if (code === 'permission-denied') return '권한이 없습니다. (로그인 상태나 데이터베이스 규칙을 확인하세요)';
  if (code === 'unavailable') return '서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.';
  if (code === 'auth/unauthorized-domain') return '이 주소에서는 로그인할 수 없습니다. Firebase 콘솔의 승인된 도메인에 추가하세요.';
  return (e as Error).message || String(e);
}

/** 빈 모달 틀. body에 내용을 넣고 close()로 닫는다. */
function modal(title: string, wide = false): { body: HTMLElement; foot: HTMLElement; close: () => void; closed: Promise<void> } {
  let resolve!: () => void;
  const closed = new Promise<void>((r) => (resolve = r));
  const body = h('div', { class: 'modal-body' });
  const foot = h('div', { class: 'row end' });
  const wrap = h('div', { class: 'modal-wrap ui-interactive' }, h('div', { class: 'modal' + (wide ? ' wide' : '') }, h('h2', null, title), body, foot));
  const close = () => {
    wrap.remove();
    resolve();
  };
  foot.append(h('button', { class: 'btn ghost', onclick: close }, '닫기'));
  document.body.appendChild(wrap);
  return { body, foot, close, closed };
}

/** 한 줄 입력 모달. 취소하면 null. */
export function inputBox(title: string, message: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { class: 'text-input', value, maxLength: 20 });
    const done = (v: string | null) => {
      wrap.remove();
      resolve(v);
    };
    const wrap = h(
      'div',
      { class: 'modal-wrap ui-interactive' },
      h(
        'div',
        { class: 'modal' },
        h('h2', null, title),
        h('div', { class: 'modal-body' }, h('p', null, message), input),
        h(
          'div',
          { class: 'row end' },
          h('button', { class: 'btn', onclick: () => done(null) }, '취소'),
          h('button', { class: 'btn primary', onclick: () => done(input.value) }, '확인'),
        ),
      ),
    );
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value);
      else if (e.key === 'Escape') done(null);
      e.stopPropagation();
    });
    document.body.appendChild(wrap);
    input.focus();
    input.select();
  });
}

/** 로그인 필요 시 안내 후 로그인. 로그인되면 true. */
export async function ensureSignedIn(reason: string): Promise<boolean> {
  if (currentProfile()) return true;
  if (!(await confirmBox('로그인이 필요합니다', `${reason} Google 계정으로 로그인할까요?`, '로그인'))) return false;
  try {
    await signIn();
  } catch (e) {
    await alertBox('로그인 실패', [errText(e)]);
    return false;
  }
  // onAuthStateChanged가 프로필을 채울 때까지 잠깐 기다림
  for (let i = 0; i < 40 && !currentProfile(); i++) await new Promise((r) => setTimeout(r, 100));
  return !!currentProfile();
}

/** 타이틀 화면의 계정 줄: 로그인 버튼 또는 '이름 · 이름 변경 · 로그아웃'. */
export function accountBar(): HTMLElement | null {
  if (!onlineAvailable()) return null;
  const el = h('div', { class: 'account-bar' });
  let first = true;
  const off = onProfile((p) => {
    // 화면을 떠나 계정 줄이 사라졌으면 더 듣지 않는다
    if (!first && !el.isConnected) {
      off();
      return;
    }
    first = false;
    el.innerHTML = '';
    if (!p) {
      el.append(
        h(
          'button',
          {
            class: 'btn small',
            onclick: () => void signIn().catch((e) => alertBox('로그인 실패', [errText(e)])),
          },
          'Google로 로그인',
        ),
        h('span', { class: 'dim' }, ' 온라인 레벨·순위·설정 동기화'),
      );
    } else {
      el.append(
        h('span', null, `${p.name} 님`),
        h(
          'button',
          {
            class: 'btn small ghost',
            onclick: async () => {
              const n = await inputBox('이름 변경', '순위표와 올린 레벨에 보이는 이름입니다 (20자까지).', p.name);
              if (n === null) return;
              try {
                await setNickname(cleanName(n));
              } catch (e) {
                await alertBox('이름을 바꿀 수 없습니다', [errText(e)]);
              }
            },
          },
          '이름 변경',
        ),
        h('button', { class: 'btn small ghost', onclick: () => void signOut() }, '로그아웃'),
      );
    }
  });
  return el;
}

const mb = (n: number) => `${(n / 1048576).toFixed(1)}MB`;

/** 온라인 레벨 목록. 받은 레벨을 onPick으로 넘긴다. */
export async function openOnlineLevels(onPick: (pkg: LevelPackage) => void): Promise<void> {
  const m = modal('온라인 레벨', true);
  m.body.append(h('p', null, '불러오는 중…'));
  let items: CloudLevel[];
  try {
    items = await listLevels();
  } catch (e) {
    m.body.innerHTML = '';
    m.body.append(h('p', null, `목록을 불러올 수 없습니다: ${errText(e)}`));
    return;
  }
  const render = () => {
    m.body.innerHTML = '';
    if (!items.length) {
      m.body.append(h('p', null, '아직 올라온 레벨이 없습니다. 레벨을 고르고 "올리기"를 눌러 첫 레벨을 올려보세요.'));
      return;
    }
    const me = currentProfile();
    for (const it of items) {
      const get = h('button', { class: 'btn small primary' }, '받기');
      get.onclick = async () => {
        get.disabled = true;
        get.textContent = '받는 중…';
        try {
          const pkg = await downloadLevel(it.id);
          m.close();
          onPick(pkg);
          if (pkg.warnings.length) toast(pkg.warnings.join(' '), 4000);
        } catch (e) {
          get.disabled = false;
          get.textContent = '받기';
          await alertBox('받을 수 없습니다', [errText(e)]);
        }
      };
      const del =
        me && me.uid === it.ownerUid
          ? h('button', {
              class: 'btn small ghost',
              onclick: async () => {
                if (!(await confirmBox('레벨 삭제', `'${it.title}'을(를) 온라인에서 삭제할까요? 되돌릴 수 없습니다.`, '삭제'))) return;
                try {
                  await deleteLevel(it.id);
                  items = items.filter((x) => x !== it);
                  render();
                } catch (e) {
                  await alertBox('삭제할 수 없습니다', [errText(e)]);
                }
              },
            }, '삭제')
          : null;
      m.body.append(
        h(
          'div',
          { class: 'online-row' },
          h(
            'div',
            { class: 'grow' },
            h('b', null, it.title),
            h('div', { class: 'dim' }, `${it.artist || '알 수 없음'} · 올린 사람 ${it.author || '?'}`),
            h('div', { class: 'dim' }, `${it.bpm} BPM · ${it.tiles} 타일 · ${it.hasSong ? `음원 ${mb(it.bytes)}` : '음원 없음'} · `, h('span', { class: 'stars-inline' }, stars(it.difficulty))),
          ),
          del,
          get,
        ),
      );
    }
  };
  render();
  await m.closed;
}

/** WAV 같은 큰 음원은 mp3로 줄여 올린다. */
async function shrinkSong(pkg: LevelPackage, files: { name: string; data: Uint8Array }[]): Promise<{ files: { name: string; data: Uint8Array }[]; rename?: string }> {
  const song = pkg.level.settings.songFile;
  const i = files.findIndex((f) => f.name === song);
  if (i < 0) return { files };
  const f = files[i];
  const isWav = /\.wav$/i.test(f.name);
  if (!isWav && f.data.length <= MAX_FILE_BYTES) return { files };
  toast('음원을 mp3로 줄이는 중…', 3000);
  const buf = await loadPackageAudio(pkg);
  const { encodeMp3 } = await import('../audio/mp3');
  const chs = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c));
  const data = await encodeMp3(chs, buf.sampleRate, { kbps: chs.length === 2 ? 160 : 128 });
  const name = f.name.replace(/\.[^.]+$/, '') + '.mp3';
  const out = files.slice();
  out[i] = { name, data };
  return { files: out, rename: name };
}

/** 선택한 레벨(과 음원)을 온라인에 올린다. */
export async function uploadSelected(pkg: LevelPackage): Promise<void> {
  if (pkg.imported === 'adofai') {
    const go = await confirmBox(
      '원작에서 가져온 레벨입니다',
      '얼음과 불의 춤에서 변환한 레벨은 원작 맵 제작자와 음원의 저작권이 있어요. 개인 플레이용으로만 쓰는 것을 권합니다.\n' +
        '제작자와 음원 권리자에게 허락을 받은 경우에만 올려 주세요.',
      '허락받았음 — 올리기',
    );
    if (!go) return;
  }
  if (!(await ensureSignedIn('레벨을 올리려면 로그인해야 합니다.'))) return;
  let files = referencedFiles(pkg);
  const hasSong = !!pkg.level.settings.songFile && !!findFile(pkg.files, pkg.level.settings.songFile);
  const ok = await confirmBox(
    '온라인에 올리기',
    `'${pkg.level.meta.title}'을(를) ${hasSong ? '음원과 함께 ' : ''}올립니다. 로그인한 사람 누구나 받아서 플레이할 수 있어요.` +
      (hasSong ? '\n직접 만들었거나 공유해도 되는 음원인지 확인해 주세요.' : ''),
    '올리기',
  );
  if (!ok) return;
  const level = pkg.level;
  try {
    const shrunk = await shrinkSong(pkg, files);
    files = shrunk.files;
    const up: LevelPackage = shrunk.rename ? { ...pkg, level: { ...level, settings: { ...level.settings, songFile: shrunk.rename } } } : pkg;
    const m = modal('올리는 중');
    const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
    const label = h('p', null, '0%');
    m.body.append(bar, label);
    m.foot.innerHTML = '';
    try {
      await uploadLevel(up, files, (r) => {
        (bar.firstChild as HTMLElement).style.width = `${Math.round(r * 100)}%`;
        label.textContent = `${Math.round(r * 100)}%`;
      });
    } finally {
      m.close();
    }
    toast('올렸습니다! "온라인 레벨"에서 볼 수 있어요.', 3500);
  } catch (e) {
    await alertBox('올릴 수 없습니다', [errText(e)]);
  }
}

/** 선택한 레벨의 순위표. */
export async function openRanking(pkg: LevelPackage): Promise<void> {
  const key = rankKey(pkg);
  const m = modal(`순위 — ${pkg.level.meta.title}`);
  if (!key) {
    m.body.append(h('p', null, '이 레벨은 순위가 없습니다. 온라인에 올린 뒤 "온라인 레벨"에서 받은 레벨이나, 게임에 포함된 레벨에서 순위가 기록됩니다.'));
    return;
  }
  m.body.append(h('p', null, '불러오는 중…'));
  try {
    const rows = await topScores(key);
    m.body.innerHTML = '';
    if (!rows.length) m.body.append(h('p', null, '아직 기록이 없습니다. 로그인하고 클리어하면 첫 기록이 됩니다.'));
    const me = currentProfile();
    const table = h('table', { class: 'rank' });
    rows.forEach((r, i) => table.append(h('tr', { class: me && r.uid === me.uid ? 'me' : '' }, h('td', null, String(i + 1)), h('td', null, r.name), h('td', null, `${r.acc.toFixed(2)}%`))));
    if (rows.length) m.body.append(table);
    if (!me) m.body.append(h('p', null, '로그인하면 내 기록도 올라갑니다.'));
  } catch (e) {
    m.body.innerHTML = '';
    m.body.append(h('p', null, `순위를 불러올 수 없습니다: ${errText(e)}`));
  }
  await m.closed;
}
