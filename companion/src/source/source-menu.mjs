import { createInterface } from 'node:readline/promises';

// The interactive menu is a separate, short-lived CLI process. It never reads
// from the long-running watch process or modifies the official Lilac program.
export async function runSourceMenu({
  dispatch,
  loadProviders,
  loadAnimeTargets = null,
  loadAnimeRules = null,
  showAnimePolicy = null,
  changeAnimePolicy = null,
  deleteAnimePolicy = null,
  prompt = null,
  log = message => console.log(message)
}) {
  if (typeof dispatch !== 'function' || typeof loadProviders !== 'function') {
    throw new TypeError('Source manager requires dispatch and loadProviders');
  }
  const modeLabel = { intensive: '집중 진단', normal: '일반 진단', off: '진단 제외' };
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


  async function manageAnimeSources() {
    if (typeof loadAnimeTargets !== 'function' || typeof loadAnimeRules !== 'function' ||
        typeof changeAnimePolicy !== 'function' || typeof deleteAnimePolicy !== 'function') {
      log('이 빌드에는 작품별 소스 설정 기능이 없습니다.');
      return;
    }
    while (true) {
      log('\n=== 작품별 소스 설정 ===');
      log('[1] 현재 재생 중이거나 최근 본 작품 선택');
      log('[2] 저장된 작품별 설정 목록·삭제');
      log('[0] 이전 메뉴');
      const menu = await read('번호 선택 > ');
      if (menu === '0') return;
      if (menu === '2') {
        const rules = await loadAnimeRules();
        if (!rules.length) {
          log('저장된 작품별 소스 설정이 없습니다.');
          continue;
        }
        rules.forEach((item, i) => {
          log('[' + (i + 1) + '] ' + item.title + ' · 선호: ' +
            (item.series.preferred || '자동') + ' · 제외: ' +
            (item.series.excluded.join(', ') || '없음') + ' · 회차별 설정 ' +
            Object.keys(item.episodes).length + '개');
        });
        log('[0] 뒤로');
        const idx = selectIndex(await read('삭제할 작품 번호 (0 = 취소) > '), rules.length);
        if (idx === -1) continue;
        if (await read('해당 작품의 전체 규칙을 삭제하려면 1 입력 > ') === '1') {
          await deleteAnimePolicy(rules[idx].key);
          log('해당 작품의 저장된 설정을 삭제했습니다.');
        }
        continue;
      }
      if (menu !== '1') { log('0~2 중 선택하세요.'); continue; }

      const targets = await loadAnimeTargets();
      if (!targets.length) {
        log('최근 재생한 작품이 없습니다. 라일락에서 작품의 회차를 한 번 재생한 뒤 열어주세요.');
        continue;
      }
      log('\n설정할 작품 선택');
      targets.forEach((ctx, i) => {
        const a = ctx.anime;
        log('[' + (i + 1) + '] ' + (a.title || a.title_english || a.romaji) +
          ' · ' + (ctx.episode?.number || '?') + '화' +
          (ctx.activePlayer ? ' (현재 재생)' : ' (최근 재생)'));
      });
      log('[0] 뒤로');
      const idx = selectIndex(await read('작품 번호 > '), targets.length);
      if (idx === -1) continue;
      const target = targets[idx];
      if (typeof showAnimePolicy === 'function') {
        const rule = await showAnimePolicy(target);
        log('현재 적용 정책: ' + (rule
          ? '우선 ' + (rule.preferred || '자동') +
            (rule.locked ? ' (고정)' : '') + ', 제외 ' +
            (rule.excluded.join(', ') || '없음')
          : '자동 화질·안정성 선택'));
      }
      log('[1] 작품 전체(시즌) 적용');
      log('[2] 이 회차에만 추가 적용 (' + target.episode.number + '화)');
      log('[0] 취소');
      const scopeChoice = await read('설정 범위 > ');
      const scope = scopeChoice === '1' ? 'series' : scopeChoice === '2' ? 'episode' : '';
      if (!scope) continue;

      log('[1] 특정 소스 우선: 정상 작동하면 해당 소스 우선, 실패 시 자동');
      log('[2] 특정 소스 고정: 지정 소스가 사용 불가하면 자동 전환 안 함');
      log('[3] 특정 소스 제외: 이 작품에서만 자동 선택 금지');
      log('[4] 제외 해제: 이 범위에서 제외했던 소스만 복구');
      log('[5] 이 범위의 규칙 초기화');
      log('[0] 취소');
      const operation = { '1': 'prefer', '2': 'lock', '3': 'exclude', '4': 'allow', '5': 'clear' }[
        await read('동작 번호 > ')
      ];
      if (!operation) continue;
      let provider = '';
      if (operation !== 'clear') {
        const providers = await loadProviders();
        if (!providers.length) { log('먼저 라일락과 연결해 소스 목록을 동기화하세요.'); continue; }
        providers.forEach((item, i) => {
          log('[' + (i + 1) + '] ' + item.label + ' · ' +
            (modeLabel[item.mode] || item.mode) + (item.present ? '' : ' (현재 소스 목록에 없음)'));
        });
        log('[0] 취소');
        const providerIndex = selectIndex(await read('소스 번호 > '), providers.length);
        if (providerIndex === -1) continue;
        const selected = providers[providerIndex];
        if (['prefer', 'lock'].includes(operation) && (!selected.present || selected.mode === 'off')) {
          log('이 소스는 라일락에 없거나 전체 진단에서 제외돼 있어 우선·고정할 수 없습니다.');
          continue;
        }
        provider = selected.id;
      }
      await changeAnimePolicy(target, scope, operation, provider);
      log('작품별 설정을 저장했습니다. Companion 감시 중에도 다음 진단부터 적용됩니다.');
    }
  }

  try {
    log('\n=== Lilac Companion · 소스 관리 ===');
    log('이 창은 소스 설정용입니다. 실행 중인 Companion 감시 창은 그대로 유지됩니다.');
    log('집중 진단 기본값: 애니24, RE:Anime, Miruro');
    log('나머지 활성 소스도 1차 화질·안정성 검사를 거쳐 좋은 후보는 심층 진단합니다.');
    log('집중 진단은 심층 검사 우선권일 뿐, 해당 소스의 자동 선택을 강제하지 않습니다.');
    await dispatch('list');

    while (true) {
      log('\n[1] 소스 목록·설정 보기');
      log('[2] 라일락 소스 목록 지금 동기화');
      log('[3] 소스별 진단 모드 변경');
      log('[4] 직전 설정 변경 취소');
      log('[5] 재생 중인 회차 수동 화질·안정성 진단');
      log('[6] 작품별 소스 선호·제외·고정 설정');
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
            log(`[${index + 1}] ${provider.label} (${provider.id}) · ${modeLabel[provider.mode] || provider.mode}${presence}`);
          });
          const index = selectIndex(await read('소스 번호 > '), providers.length);
          if (index === -1) {
            log('선택을 취소했거나 올바르지 않은 번호입니다.');
            continue;
          }
          const selected = providers[index];
          log(`\n${selected.label} (${selected.id}) 설정`);
          log('[1] 집중 진단: 심층 검사의 우선권 (자동 선택 강제 아님)');
          log('[2] 일반 진단: 가벼운 전체 검사 + 결과가 좋으면 심층 검사');
          log('[3] 제외: Companion 자동 진단·선택에서만 제외 (라일락에는 유지)');
          log('[4] 초기화: 해당 소스의 기본 진단 모드 복구');
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
        } else if (action === '6') {
          await manageAnimeSources();
        } else {
          log('0~6 중 하나의 번호를 입력하세요.');
        }
      } catch (error) {
        log(`[source manager] 작업을 완료하지 못했습니다: ${error?.message || error}`);
      }
    }
  } finally {
    terminal?.close();
  }
}
