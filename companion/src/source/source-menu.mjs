import { createInterface } from 'node:readline/promises';

// The interactive menu is a separate, short-lived CLI process. It never reads
// from the long-running watch process or modifies the official Lilac program.
export async function runSourceMenu({
  dispatch,
  loadProviders,
  prompt = null,
  log = message => console.log(message)
}) {
  if (typeof dispatch !== 'function' || typeof loadProviders !== 'function') {
    throw new TypeError('Source manager requires dispatch and loadProviders');
  }
  const terminal = prompt ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = prompt || (message => terminal.question(message));
  async function read(message) {
    try { return String((await ask(message)) ?? '').trim(); }
    catch (error) {
      if (error?.code === 'ERR_USE_AFTER_CLOSE') return '0';
      throw error;
    }
  }
  const selectIndex = (value, count) => {
    if (!/^\d+$/.test(value)) return -1;
    const number = Number(value);
    return number >= 1 && number <= count ? number - 1 : -1;
  };

  try {
    log('\n=== Lilac Companion · 소스 관리 ===');
    log('이 창은 소스 설정용입니다. 실행 중인 Companion 감시 창은 그대로 유지됩니다.');
    log('집중 진단 기본값: 애니24, RE:Anime, Miruro');
    log('나머지 활성 소스도 1차 화질·안정성 검사를 거쳐 좋은 후보는 심층 진단합니다.');
    await dispatch('list');

    while (true) {
      log('\n[1] 소스 목록·설정 보기');
      log('[2] 라일락 소스 목록 지금 동기화');
      log('[3] 소스별 진단 모드 변경');
      log('[4] 직전 설정 변경 취소');
      log('[5] 재생 중인 회차 수동 화질·안정성 진단');
      log('[0] 종료');
      const action = await read('번호 선택 > ');
      if (action === '0') return;
      try {
        if (action === '1') {
          await dispatch('list');
        } else if (action === '2') {
          await dispatch('sync');
        } else if (action === '3') {
          const providers = await loadProviders();
          if (!providers.length) {
            log('등록된 소스가 없습니다. 라일락을 연결한 뒤 [2] 동기화를 실행하세요.');
            continue;
          }
          log('\n변경할 소스를 선택하세요. (0 = 뒤로)');
          providers.forEach((provider, index) => {
            const presence = provider.present ? '' : ' · 라일락에서 현재 보이지 않음';
            log(`[${index + 1}] ${provider.label} (${provider.id}) · ${provider.mode}${presence}`);
          });
          const index = selectIndex(await read('소스 번호 > '), providers.length);
          if (index === -1) {
            log('선택을 취소했거나 올바르지 않은 번호입니다.');
            continue;
          }
          const selected = providers[index];
          log(`\n${selected.label} (${selected.id}) 설정`);
          log('[1] 집중 진단 우선순위 (focus)');
          log('[2] 일반 진단 (normal)');
          log('[3] Companion 자동 진단·선택 제외 (off)');
          log('[4] 기본 설정 복구 (reset)');
          log('[0] 취소');
          const mode = { '1': 'focus', '2': 'normal', '3': 'off', '4': 'reset' }[await read('모드 번호 > ')];
          if (!mode) {
            log('설정을 변경하지 않았습니다.');
            continue;
          }
          await dispatch(mode, selected.id);
        } else if (action === '4') {
          await dispatch('undo');
        } else if (action === '5') {
          log('실제 스트림 데이터를 내려받는 수동 진단입니다. 재생 중인 회차가 있어야 합니다.');
          await dispatch('source-doctor');
        } else {
          log('0~5 중 하나의 번호를 입력하세요.');
        }
      } catch (error) {
        log(`[source manager] 작업을 완료하지 못했습니다: ${error?.message || error}`);
      }
    }
  } finally {
    terminal?.close();
  }
}
