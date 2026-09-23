import type { AutoDifficulty } from '../core/autochart';
import { levelFromHits } from '../core/autochart';
import { audio } from '../audio/engine';
import { beatTime, composeSong, encodeWav, MOODS, renderSong, songFill, songHits, type Mood } from '../audio/songgen';
import { newPackageId, type LevelPackage } from '../levels/package';
import { h, toast } from './dom';

export interface GenChoice {
  mood: Mood;
  seconds: number;
  bpm: number;
  difficulty: AutoDifficulty;
}

let last: GenChoice = { mood: 'upbeat', seconds: 60, bpm: 124, difficulty: 'normal' };

/** 곡 작곡 + 합성 + 레벨 생성 → 패키지. */
export function generatePackage(c: GenChoice, seed = Math.floor(Math.random() * 9000) + 1000): { pkg: LevelPackage; summary: string } {
  const song = composeSong({ mood: c.mood, bpm: c.bpm, seconds: c.seconds, seed });
  const eng = audio();
  const sr = eng.ctx.sampleRate;
  const pcm = renderSong(song, sr);
  const label = MOODS.find((m) => m.value === c.mood)!.label;
  const file = `orbit-${c.mood}-${seed}.wav`;
  const first = beatTime(song, song.levelStartBeat);
  const firstA = song.sections.find((s) => s.name === 'A');
  const r = levelFromHits(songHits(song, c.difficulty), song.bpm, first, {
    title: `${label} 곡 #${seed}`,
    artist: 'ORBIT 작곡',
    songFile: file,
    difficulty: { easy: 2, normal: 4, hard: 6 }[c.difficulty],
    previewStart: firstA ? beatTime(song, firstA.bar * 4) : 0,
    fill: songFill(song),
  });
  if (!r) throw new Error('곡이 너무 짧아 레벨을 만들 수 없습니다. 길이를 늘려 주세요.');
  const pkg: LevelPackage = {
    id: newPackageId('gen'),
    level: r.level,
    files: new Map([[file, encodeWav(pcm, sr)]]),
    builtin: false,
    warnings: [],
    buffer: eng.bufferFromSamples(pcm, sr),
    synthesized: false,
  };
  return { pkg, summary: `${song.bpm} BPM · ${Math.round((song.bars * 4 * 60) / song.bpm)}초 · 타일 ${r.tiles}개` };
}

/** 음악 자동 생성 창. 만들면 패키지, 취소하면 null. */
export function openSongGenerator(): Promise<LevelPackage | null> {
  return new Promise((resolve) => {
    const c: GenChoice = { ...last };
    const done = (v: LevelPackage | null) => {
      wrap.remove();
      resolve(v);
    };
    const moodRow = h('div', { class: 'row' });
    const bpmIn = h('input', { type: 'number', id: 'gen-bpm', min: 60, max: 200, value: String(c.bpm), style: 'width:90px' });
    const renderMoods = () => {
      moodRow.innerHTML = '';
      for (const m of MOODS)
        moodRow.append(
          h(
            'button',
            {
              class: 'btn small' + (c.mood === m.value ? ' primary' : ''),
              title: m.hint,
              onclick: () => {
                c.mood = m.value;
                c.bpm = m.bpm;
                bpmIn.value = String(m.bpm);
                renderMoods();
              },
            },
            m.label,
          ),
        );
    };
    renderMoods();
    const len = h(
      'select',
      { id: 'gen-len', onchange: () => (c.seconds = Number(len.value)) },
      ...[30, 45, 60, 90, 120, 180].map((s) => h('option', { value: String(s) }, s < 60 ? `${s}초` : `${s / 60}분${s % 60 ? ' 30초' : ''}`)),
    );
    len.value = String(c.seconds);
    const diff = h(
      'select',
      { id: 'gen-diff', onchange: () => (c.difficulty = diff.value as AutoDifficulty) },
      h('option', { value: 'easy' }, '쉬움 — 킥·스네어'),
      h('option', { value: 'normal' }, '보통 — + 멜로디'),
      h('option', { value: 'hard' }, '어려움 — + 베이스'),
    );
    diff.value = c.difficulty;
    const status = h('p', { class: 'dim' }, '매번 새 곡이 만들어집니다. 마음에 안 들면 다시 만드세요.');
    const make = h('button', { class: 'btn primary' }, '만들기');
    make.addEventListener('click', async () => {
      c.bpm = Math.max(60, Math.min(200, Math.round(Number(bpmIn.value) || c.bpm)));
      last = { ...c };
      make.disabled = true;
      status.textContent = '작곡하고 합성하는 중…';
      await new Promise((r) => setTimeout(r, 30));
      try {
        const { pkg, summary } = generatePackage(c);
        toast(`만들었습니다: ${summary}`, 3500);
        done(pkg);
      } catch (e) {
        status.textContent = (e as Error).message;
        make.disabled = false;
      }
    });
    const wrap = h(
      'div',
      { class: 'modal-wrap ui-interactive' },
      h(
        'div',
        { class: 'modal' },
        h('h2', null, '음악 자동 생성'),
        h('p', { class: 'dim' }, '게임이 곡을 직접 작곡해 드럼·베이스·멜로디·화음으로 합성하고, 음표 위치에 맞춰 레벨을 만듭니다.'),
        h(
          'div',
          { class: 'form', style: 'grid-template-columns: 70px 1fr; margin: 14px 0; gap: 10px' },
          h('label', null, '분위기'),
          moodRow,
          h('label', { for: 'gen-len' }, '길이'),
          len,
          h('label', { for: 'gen-bpm' }, 'BPM'),
          h('div', { class: 'row' }, bpmIn, h('span', { class: 'dim' }, '60~200')),
          h('label', { for: 'gen-diff' }, '난이도'),
          diff,
        ),
        status,
        h('div', { class: 'row end' }, h('button', { class: 'btn ghost', onclick: () => done(null) }, '취소'), make),
      ),
    );
    document.body.appendChild(wrap);
    make.focus();
  });
}
