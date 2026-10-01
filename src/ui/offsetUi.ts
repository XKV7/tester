import { currentProfile, deviceOffsetMs, setDeviceOffset } from '../audio/device';
import { worthSuggesting, type OffsetHint } from '../core/offset';
import { saveSettings, settings } from '../game/settings';
import { h } from './dom';

/**
 * 친 타이밍으로 본 기기 오프셋 추천 (결과·일시정지 화면). 추천할 게 없으면 null.
 * hint.median = 엔진 시계 기준 평균 오차 (개인 입력 오프셋까지 더한 값) → 추천 기기 오프셋 = median − 입력 오프셋.
 */
export function offsetSuggestion(hint: OffsetHint | null): HTMLElement | null {
  if (!hint) return null;
  const cur = deviceOffsetMs();
  const next = Math.max(-200, Math.min(1000, hint.median - settings.inputOffset));
  if (!worthSuggesting({ ...hint, median: next }, cur)) return null;
  const diff = next - cur;
  const box = h('div', { class: 'offset-hint', style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:center;font-size:14px;margin-top:6px' });
  box.append(
    h('span', { class: 'dim' }, `이번 판은 평균 ${Math.abs(diff)}ms ${diff > 0 ? '늦게' : '빠르게'} 쳤어요 (${hint.count}번 기준) · 기기 오프셋 ${cur} → ${next}ms`),
    h(
      'button',
      {
        class: 'btn small primary',
        onclick: () => {
          setDeviceOffset(next);
          box.replaceChildren(h('span', { class: 'dim' }, `기기 오프셋을 ${next}ms로 맞췄어요 (이 오디오 기기에만).`));
        },
      },
      '맞추기',
    ),
  );
  return box;
}

/** 기기 오프셋·화면 미세조정을 그 자리에서 ±조절 (바로 저장, 게임 중에도 바로 적용). */
export function offsetNudger(): HTMLElement {
  const row = (label: string, get: () => number, set: (v: number) => void, tip: string) => {
    const val = h('span', { style: 'min-width:72px;text-align:center;font-weight:700' });
    const showVal = () => (val.textContent = `${get() > 0 ? '+' : ''}${get()}ms`);
    const step = (d: number) => {
      set(get() + d);
      showVal();
    };
    showVal();
    const b = (t: string, d: number) => h('button', { class: 'btn small', onclick: () => step(d) }, t);
    return h(
      'div',
      { style: 'display:flex;gap:6px;align-items:center;justify-content:center', title: tip },
      h('span', { class: 'dim', style: 'min-width:80px;text-align:right' }, label),
      b('−10', -10),
      b('−2', -2),
      val,
      b('+2', 2),
      b('+10', 10),
    );
  };
  const p = currentProfile();
  return h(
    'div',
    { class: 'col', style: 'gap:6px;margin-top:8px;align-items:center' },
    row('기기 오프셋', deviceOffsetMs, (v) => setDeviceOffset(Math.max(-200, Math.min(1000, v))), '소리가 늦게 들리는 만큼 (판정과 화면을 함께 옮김)'),
    row(
      '화면 미세',
      () => settings.visualOffset,
      (v) => {
        settings.visualOffset = Math.max(-300, Math.min(300, v));
        saveSettings();
      },
      '행성이 소리보다 늦게 닿아 보이면 +',
    ),
    h(
      'div',
      { class: 'dim', style: 'font-size:12px;text-align:center;max-width:340px' },
      `${p ? '' : '이 오디오 기기는 아직 보정 전이에요. '}기기 오프셋 +: 늦게 쳐도 맞게 · 화면 미세 +: 행성이 소리보다 늦게 닿아 보일 때`,
    ),
  );
}
