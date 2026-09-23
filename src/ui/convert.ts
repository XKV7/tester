import { audio } from '../audio/engine';
import { encodeMp3 } from '../audio/mp3';
import { decodeErrorMessage, download, SONG_ACCEPT } from '../levels/package';
import { fileInput, h } from './dom';

const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`);
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * 동영상(또는 다른 음원) → mp3 변환 창. 기기 안에서만 처리 (업로드 없음).
 * "이 곡으로 레벨 만들기"를 누르면 mp3 File을, 그 외에는 null을 돌려준다.
 */
export function openMp3Converter(): Promise<File | null> {
  return new Promise((resolve) => {
    let result: File | null = null;
    const done = (v: File | null) => {
      wrap.remove();
      resolve(v);
    };
    const quality = h(
      'select',
      { id: 'mp3-kbps' },
      h('option', { value: '128' }, '128kbps — 작은 용량 (1분 ≈ 1MB)'),
      h('option', { value: '192' }, '192kbps — 보통 (1분 ≈ 1.4MB)'),
      h('option', { value: '320' }, '320kbps — 고음질 (1분 ≈ 2.4MB)'),
    );
    quality.value = '192';
    const status = h('p', { class: 'dim' }, '동영상(mp4·webm·mov 등)이나 wav 같은 큰 음원 파일을 고르세요. 파일은 인터넷에 올라가지 않고 이 기기 안에서만 변환됩니다.');
    const bar = h('div', { style: 'width:0%' });
    const progress = h('div', { class: 'progress-line', hidden: true }, bar);
    const actions = h('div', { class: 'row end' });
    const pick = fileInput({ accept: SONG_ACCEPT }, (f) => void convert(f[0]));
    const pickBtn = h('button', { class: 'btn primary', onclick: () => pick.click() }, '파일 고르기');
    const closeBtn = h('button', { class: 'btn ghost', onclick: () => done(null) }, '닫기');
    actions.append(closeBtn, pickBtn);

    const convert = async (file: File | undefined) => {
      if (!file) return;
      pickBtn.disabled = true;
      progress.hidden = false;
      bar.style.width = '0%';
      status.textContent = `${file.name} — 소리를 꺼내는 중…`;
      let buf: AudioBuffer;
      try {
        buf = await audio().decode(await file.arrayBuffer());
      } catch {
        status.textContent = decodeErrorMessage(file.name);
        pickBtn.disabled = false;
        progress.hidden = true;
        return;
      }
      const chans = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c));
      status.textContent = `mp3로 변환하는 중… (${fmtTime(buf.duration)})`;
      const t0 = performance.now();
      const bytes = await encodeMp3(chans, buf.sampleRate, {
        kbps: Number(quality.value),
        onProgress: (r) => {
          bar.style.width = `${Math.round(r * 100)}%`;
        },
      });
      const name = file.name.replace(/\.[^.]+$/, '') + '.mp3';
      result = new File([bytes as Uint8Array<ArrayBuffer>], name, { type: 'audio/mpeg' });
      status.textContent = `완료: ${name} · ${fmtTime(buf.duration)} · ${fmtSize(file.size)} → ${fmtSize(bytes.length)} (${((performance.now() - t0) / 1000).toFixed(1)}초)`;
      actions.innerHTML = '';
      const save = h('button', { class: 'btn' }, 'mp3 저장');
      save.addEventListener('click', async () => {
        const r = await download(name, bytes, 'audio/mpeg');
        if (r === 'saved') status.textContent = `저장했습니다: ${name}`;
        else if (r === 'saved-zip')
          status.textContent = `이 화면에서는 mp3를 바로 저장할 수 없어 ${name.replace(/\.mp3$/, '.zip')}(안에 mp3)로 저장했습니다. zip을 그대로 "음원으로 레벨 만들기"에 넣어도 됩니다.`;
        else if (r === 'failed') status.textContent = '저장할 수 없습니다. 이 기기에서 다운로드가 막혀 있을 수 있습니다.';
      });
      actions.append(
        h('button', { class: 'btn ghost', onclick: () => done(null) }, '닫기'),
        h('button', { class: 'btn', onclick: () => ((actions.innerHTML = ''), (progress.hidden = true), (pickBtn.disabled = false), actions.append(closeBtn, pickBtn), (status.textContent = '다른 파일을 고르세요.')) }, '다른 파일'),
        save,
        h('button', { class: 'btn primary', onclick: () => done(result) }, '이 곡으로 레벨 만들기'),
      );
    };

    const wrap = h(
      'div',
      { class: 'modal-wrap ui-interactive' },
      h(
        'div',
        { class: 'modal' },
        h('h2', null, '동영상 → mp3 변환'),
        h('div', { class: 'form', style: 'grid-template-columns: 70px 1fr; margin: 10px 0' }, h('label', { for: 'mp3-kbps' }, '음질'), quality),
        status,
        progress,
        pick,
        actions,
      ),
    );
    document.body.appendChild(wrap);
    pickBtn.focus();
  });
}
