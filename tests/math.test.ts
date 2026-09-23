import { describe, expect, it } from 'vitest';
import { entryAngle, rotationTheta, thetaToBeats, tilePositions, floorIndex } from '../src/core/math';

const beats = (start: number, target: number, dir: 'CW' | 'CCW' = 'CW') => thetaToBeats(rotationTheta(start, target, dir));

describe('회전 각도 → 박 수 (2.3)', () => {
  // 진행 방향 오른쪽 (이전 path = 0 → start = 180)
  it('직진 = 1박', () => expect(beats(180, 0)).toBe(1));
  it('위로 꺾기(좌회전) = 0.5박', () => expect(beats(180, 90)).toBe(0.5));
  it('아래로 꺾기(우회전) = 1.5박', () => expect(beats(180, 270)).toBe(1.5));
  it('아래로 꺾기(-90 표기) = 1.5박', () => expect(beats(180, -90)).toBe(1.5));
  it('U턴 = 2박', () => expect(beats(180, 180)).toBe(2));
  it('대각선 45° 꺾기 = 0.75 / 1.25박', () => {
    expect(beats(180, 45)).toBe(0.75);
    expect(beats(180, -45)).toBe(1.25);
  });
  it('3박자 계열 60° / 120°', () => {
    expect(beats(180, 60)).toBeCloseTo(2 / 3, 10);
    expect(beats(180, 120)).toBeCloseTo(1 / 3, 10);
  });
  it('Midspin은 θ=0 허용', () => {
    expect(rotationTheta(180, 180, 'CW', true)).toBe(0);
  });
});

describe('CW / CCW', () => {
  it('CCW는 반대 방향으로 계산', () => {
    expect(beats(180, 90, 'CCW')).toBe(1.5);
    expect(beats(180, 270, 'CCW')).toBe(0.5);
    expect(beats(180, 0, 'CCW')).toBe(1);
    expect(beats(180, 180, 'CCW')).toBe(2);
  });
  it('CW + CCW 박 합은 2 (U턴 제외)', () => {
    for (const t of [15, 45, 90, 135, 200, 270, 330]) expect(beats(180, t, 'CW') + beats(180, t, 'CCW')).toBeCloseTo(2);
  });
});

describe('타일 위치', () => {
  it('path 누적', () => {
    const p = tilePositions([0, 90, 180]);
    expect(p).toHaveLength(4);
    expect(p[1].x).toBeCloseTo(100);
    expect(p[2].x).toBeCloseTo(100);
    expect(p[2].y).toBeCloseTo(100);
    expect(p[3].x).toBeCloseTo(0);
    expect(p[3].y).toBeCloseTo(100);
  });
  it('entryAngle', () => {
    expect(entryAngle([0, 90], 0)).toBe(180);
    expect(entryAngle([0, 90], 2)).toBe(270);
  });
  it('floorIndex 이진 탐색', () => {
    const ts = [0, 1, 1, 2, 5];
    expect(floorIndex(ts, -1)).toBe(0);
    expect(floorIndex(ts, 1)).toBe(2);
    expect(floorIndex(ts, 4.9)).toBe(3);
    expect(floorIndex(ts, 99)).toBe(4);
  });
});
