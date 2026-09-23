import type { LevelData } from '../core/types';
import { LevelBuilder, RHYTHMS as R } from './builder';

export interface DemoLevel {
  id: string;
  level: LevelData;
}

const meta = (title: string, difficulty: number) => ({
  title,
  artist: 'ORBIT 합성 비트',
  author: 'ORBIT',
  difficulty,
  previewStart: 4,
});

/** 1. 튜토리얼 (80BPM): 직진 → 꺾기 → 회전 반전 */
function tutorial(): LevelData {
  const b = LevelBuilder.create(meta('튜토리얼', 1), { bpm: 80, offset: 1 });
  b.text('박자에 맞춰 아무 키나 누르세요').straight(8);
  b.text('꺾이는 곳은 박 길이가 달라집니다').checkpoint();
  b.repeat(4, (x) => x.beats(...R.stairs));
  b.straight(3);
  b.text('소용돌이: 회전 방향이 바뀝니다').checkpoint().twirl();
  b.straight(2).repeat(3, (x) => x.beats(...R.stairs));
  b.straight(4);
  return b.build();
}

/** 2. 스윙 (96BPM): 대각선·계단·싱코페이션 */
function swing(): LevelData {
  const b = LevelBuilder.create(meta('스윙', 3), { bpm: 96, offset: 1, trackColor: '#3b4a5e' });
  b.straight(4).repeat(4, (x) => x.beats(...R.swing));
  b.straight(2).checkpoint().recolor('#4a3b5e', 24);
  b.repeat(3, (x) => x.beats(...R.stairs)).repeat(2, (x) => x.beats(...R.dotted));
  b.beats(1, 1).beats(...R.synco).twirl().beats(...R.synco).twirl();
  b.straight(2).checkpoint().recolor('#3b5e52', 30).flash('#ffffff', 0.2);
  b.repeat(3, (x) => x.beats(...R.swingBack)).beats(1, 1);
  b.repeat(2, (x) => x.beats(0.5, 0.5).twirl().beats(0.5, 0.5).twirl());
  b.straight(4);
  return b.build();
}

/** 3. 셋잇단 (88BPM): 1/3·2/3박 셔플과 셋잇단 */
function triplets(): LevelData {
  const b = LevelBuilder.create(meta('셋잇단', 5), { bpm: 88, offset: 1, trackColor: '#4b3f5e', bgColor: '#100e18' });
  b.text('3연음: 짧은 꺾임은 1/3박').straight(4);
  b.repeat(4, (x) => x.beats(2 / 3, 4 / 3));
  b.straight(2).checkpoint();
  b.repeat(4, (x) => x.beats(1 / 3, 5 / 3));
  b.straight(2).checkpoint().recolor('#5e3f55', 40).flash('#c49bff', 0.25);
  // 셋잇단 세 개: 좌우로 번갈아 꺾고, 묶음마다 방향을 뒤집어 제자리로 돌아오지 않게
  b.repeat(4, (x, i) => {
    if (i % 2 === 1) x.twirl();
    x.beats(1 / 3).twirl().beats(1 / 3).twirl().beats(1 / 3, 1);
    if (i % 2 === 1) x.twirl();
  });
  b.straight(2);
  b.repeat(4, (x, i) => (i % 2 === 0 ? x.beats(4 / 3, 2 / 3) : x.beats(2 / 3, 4 / 3)));
  b.straight(4);
  return b.build();
}

/** 4. 쉼표와 홀드 (84BPM): Pause, Hold, Midspin */
function restHold(): LevelData {
  const b = LevelBuilder.create(meta('쉼표와 홀드', 4), { bpm: 84, offset: 1, trackColor: '#5e553b', bgColor: '#12100b' });
  b.text('모래시계: 한 바퀴 더 돈 뒤에 누르세요').straight(4).pause(2).straight(3);
  b.text('노란 띠: 누른 채로 유지하다가 한 바퀴 뒤에 떼세요').checkpoint().straight(2);
  b.hold(2).straight(2).hold(2).beats(...R.stairs);
  b.text('점: 되돌아오며 바로 통과').checkpoint().straight(2);
  b.beats(0.5).midspin().beats(0.5, 1, 1);
  b.straight(1).beats(1.5).midspin().beats(1.5, 1, 1);
  b.checkpoint().repeat(2, (x) => x.beats(...R.swing)).pause(2).beats(...R.stairs).hold(1, 1).straight(4);
  return b.build();
}

/** 5. 가속 (110 → 150BPM): 속도 변경 + 카메라 줌아웃 */
function accel(): LevelData {
  const b = LevelBuilder.create(meta('가속', 7), { bpm: 110, offset: 1, trackColor: '#553a3f', bgColor: '#120d14' });
  b.straight(6).repeat(3, (x) => x.beats(...R.stairs)).straight(2);
  b.checkpoint().speed(150).camera({ zoom: 0.7, duration: 4, ease: 'outSine' }).flash('#ff7a5c', 0.4, 2).background('#1a0f18');
  b.straight(6).repeat(3, (x) => x.beats(...R.swing)).straight(2);
  b.checkpoint().twirl().repeat(3, (x) => x.beats(...R.stairs)).twirl();
  b.straight(2).beats(0.5).midspin().beats(0.5, 1).repeat(2, (x) => x.beats(...R.dotted));
  b.camera({ zoom: 1, duration: 4, ease: 'inOutSine' }).straight(6);
  return b.build();
}

export function demoLevels(): DemoLevel[] {
  return [
    { id: 'demo-tutorial', level: tutorial() },
    { id: 'demo-swing', level: swing() },
    { id: 'demo-triplets', level: triplets() },
    { id: 'demo-resthold', level: restHold() },
    { id: 'demo-accel', level: accel() },
  ];
}
