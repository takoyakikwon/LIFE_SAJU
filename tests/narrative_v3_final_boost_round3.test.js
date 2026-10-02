/**
 * Narrative V3 "최종 보정 3차"(2026-10-02) 검증.
 *
 * 2차 보정(프롬프트 지시 강화: "토씨 하나 바꾸지 말 것" + 예시)을 반영해 재생성한 PDF를
 * 다시 리뷰한 결과:
 *   - 평생운 프리미엄: 분량 17p → 15p로 줄었고, 마지막 고정 제목도 정확히 "이 사람의 인생에서
 *     결국 지켜야 할 선택 원칙"으로 나왔고, 그 뒤에 새 내용이 안 붙고 바로 끝남 — 2차 보정의
 *     needsContinuation() 하드 가드 + 프롬프트 강화가 의도대로 작동함을 확인.
 *   - 종합사주: 여전히 실패. 마지막(5번째) 큰 제목이 "움직임은 이미 시작됐고, 남은 건 무엇을
 *     남길지 고르는 일입니다"로 나왔고, 마지막 고정 제목("지금 이 사람에게 가장 중요한 선택
 *     기준")은 본문 마지막 문장 속에("마지막으로, 지금 이 사람에게 가장 중요한 선택 기준은...")
 *     한 번 더 묻혀서만 나옴. 즉 프롬프트 지시를 아무리 강화해도("토씨 하나 바꾸지 말 것") 모델이
 *     비슷한 뜻의 다른 제목으로 바꿔 쓰는 경향을 프롬프트만으로는 완전히 제거하지 못했다.
 *
 * 그래서 이번에는 프롬프트를 더 건드리는 대신(이미 두 차례 강화했는데도 재현됨), 결정적
 * (deterministic) 안전망을 서버 코드에 추가했다: 종합사주·평생운 프리미엄 모두, 최종 응답
 * 텍스트의 "마지막 [[V3_SECTION]] 섹션 제목 줄"을 추가 API 호출 없이 고정 문자열로 강제
 * 치환하는 forceFinalV3SectionTitle()을 module.exports 핸들러 마지막 단계(recordPurchase
 * 직전)에 추가했다. 본문 내용은 전혀 건드리지 않고 제목 줄만 바꾸므로, 이미 그 섹션 본문이
 * 해당 주제(선택 기준/선택 원칙)를 다루고 있다는 전제 아래 안전한 수정이다.
 *
 * 여기서는 forceFinalV3SectionTitle() 자체의 동작을 직접 단위 테스트하고(네트워크 없음,
 * 순수 문자열 함수), 실제로 재현됐던 두 PDF의 "틀린 제목" 사례를 그대로 입력해 정상적으로
 * 고쳐지는지 확인한다.
 *
 * 실행: node tests/narrative_v3_final_boost_round3.test.js
 */
const { loadInterpretModule } = require('./_interpret_loader');

function main() {
  const I = loadInterpretModule();
  let pass = 0, fail = 0;
  function check(label, actual, expected) {
    const ok = actual === expected;
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}` + (ok ? '' : `  실제=${JSON.stringify(actual)} 기대=${JSON.stringify(expected)}`));
    if (ok) pass++; else fail++;
  }
  function checkTrue(label, cond) {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}`);
    if (cond) pass++; else fail++;
  }

  // ── 1. 기본 동작: 마지막 마커의 제목 줄만 치환, 본문은 그대로 ──
  const simple = '[[V3_SECTION]]첫 번째 제목\n\n첫 번째 본문입니다.\n\n[[V3_SECTION]]잘못된 제목\n\n두 번째 본문입니다.';
  const fixedSimple = I.forceFinalV3SectionTitle(simple, '올바른 고정 제목');
  checkTrue('마지막 마커의 제목 줄이 고정 제목으로 바뀜', fixedSimple.includes('[[V3_SECTION]]올바른 고정 제목'));
  checkTrue('잘못된 원래 제목은 더 이상 제목 자리에 없음', !fixedSimple.includes('[[V3_SECTION]]잘못된 제목'));
  checkTrue('첫 번째 제목(마지막이 아닌 마커)은 그대로 유지됨', fixedSimple.includes('[[V3_SECTION]]첫 번째 제목'));
  checkTrue('두 번째 섹션 본문 내용은 글자 하나 안 바뀌고 그대로 보존됨', fixedSimple.includes('두 번째 본문입니다.'));
  checkTrue('첫 번째 섹션 본문도 보존됨', fixedSimple.includes('첫 번째 본문입니다.'));

  // ── 2. 이미 제목이 정확하면 아무것도 바꾸지 않음(동일 문자열 반환) ──
  const alreadyCorrect = '[[V3_SECTION]]올바른 고정 제목\n\n본문.';
  check('이미 정확한 제목이면 입력과 출력이 완전히 동일함', I.forceFinalV3SectionTitle(alreadyCorrect, '올바른 고정 제목'), alreadyCorrect);

  // ── 3. 마커가 전혀 없으면 아무것도 안 하고 그대로 반환 ──
  const noMarker = '그냥 평범한 본문 텍스트입니다. 마커가 전혀 없습니다.';
  check('마커가 없으면 원본을 그대로 반환(repair까지 실패한 극단 상황 대비)', I.forceFinalV3SectionTitle(noMarker, '올바른 고정 제목'), noMarker);

  // ── 4. 빈 입력 방어 ──
  check('text가 빈 문자열이면 그대로 반환', I.forceFinalV3SectionTitle('', '제목'), '');
  check('mandatedTitle이 없으면 원본 그대로 반환', I.forceFinalV3SectionTitle('[[V3_SECTION]]제목\n본문', ''), '[[V3_SECTION]]제목\n본문');

  // ── 5. 실제 재현 사례 — 종합사주: 마지막 제목이 완전히 다른 문장으로 나온 경우 ──
  const comprehensiveRepro = [
    '[[V3_SECTION]]겉으로는 버티는 사람처럼 보이지만, 실제로는 관계와 일의 압력이 먼저 삶을 흔듭니다',
    '\n\n(1번째 섹션 본문 — 그대로 보존되어야 함)\n\n',
    '[[V3_SECTION]]돈은 들어오는 힘보다, 새지 않게 묶는 방식이 더 중요합니다',
    '\n\n(2번째 섹션 본문)\n\n',
    '[[V3_SECTION]]움직임은 이미 시작됐고, 남은 건 무엇을 남길지 고르는 일입니다',
    '\n\n이 리포트에서 가장 중요한 결론은 분명합니다. (마지막 섹션 본문 — 제목만 바뀌고 이 내용은 그대로 보존되어야 함)\n\n마지막으로, 지금 이 사람에게 가장 중요한 선택 기준은 "이 선택이 내 책임만 늘리는가, 아니면 내 판단권도 함께 키우는가"입니다.',
  ].join('');
  const comprehensiveFixed = I.forceFinalV3SectionTitle(comprehensiveRepro, I.COMPREHENSIVE_V3_FINAL_TITLE);
  checkTrue('[종합사주 재현] 마지막 제목이 "지금 이 사람에게 가장 중요한 선택 기준"으로 정확히 교체됨', comprehensiveFixed.includes('[[V3_SECTION]]지금 이 사람에게 가장 중요한 선택 기준'));
  checkTrue('[종합사주 재현] 실제로 나왔던 틀린 제목("움직임은 이미 시작됐고...")은 더 이상 제목 자리에 없음', !comprehensiveFixed.includes('[[V3_SECTION]]움직임은 이미 시작됐고'));
  checkTrue('[종합사주 재현] 앞의 두 섹션 제목은 전혀 손대지 않음(1번째)', comprehensiveFixed.includes('[[V3_SECTION]]겉으로는 버티는 사람처럼 보이지만'));
  checkTrue('[종합사주 재현] 앞의 두 섹션 제목은 전혀 손대지 않음(2번째)', comprehensiveFixed.includes('[[V3_SECTION]]돈은 들어오는 힘보다'));
  checkTrue('[종합사주 재현] 마지막 섹션 본문(결론 문장)은 내용이 그대로 보존됨', comprehensiveFixed.includes('이 리포트에서 가장 중요한 결론은 분명합니다'));
  checkTrue('[종합사주 재현] 본문 중간에 섞여 있던 고정 문구 문장도 삭제되지 않고 그대로 남아있음(제목만 추가로 고쳤을 뿐 본문은 안 건드림)', comprehensiveFixed.includes('마지막으로, 지금 이 사람에게 가장 중요한 선택 기준은'));

  // ── 6. 실제 재현 사례 — 평생운 프리미엄: 1차 보정 시점에 나왔던 틀린 변형 제목 ──
  const lifetimeRepro = [
    '[[V3_SECTION]]책임을 오래 떠안아온 사람에게 변화가 시작되는 시점',
    '\n\n(흐름 A+B 본문)\n\n',
    '[[V3_SECTION]]결국 이 사람은 구조를 고를 때 운이 살아납니다',
    '\n\n이 리포트의 핵심은 하나입니다. (마지막 섹션 본문 — 보존되어야 함)',
  ].join('');
  const lifetimeFixed = I.forceFinalV3SectionTitle(lifetimeRepro, I.LIFETIME_V3_FINAL_TITLE);
  checkTrue('[평생운 재현] 마지막 제목이 "이 사람의 인생에서 결국 지켜야 할 선택 원칙"으로 정확히 교체됨', lifetimeFixed.includes('[[V3_SECTION]]이 사람의 인생에서 결국 지켜야 할 선택 원칙'));
  checkTrue('[평생운 재현] 실제로 나왔던 1차 보정 시점의 틀린 제목은 더 이상 없음', !lifetimeFixed.includes('[[V3_SECTION]]결국 이 사람은 구조를 고를 때 운이 살아납니다'));
  checkTrue('[평생운 재현] 앞 섹션 제목은 전혀 손대지 않음', lifetimeFixed.includes('[[V3_SECTION]]책임을 오래 떠안아온 사람에게 변화가 시작되는 시점'));
  checkTrue('[평생운 재현] 마지막 섹션 본문은 그대로 보존됨', lifetimeFixed.includes('이 리포트의 핵심은 하나입니다'));

  // ── 7. 2차 보정에서 실제로 성공했던 사례(제목이 이미 정확함)도 그대로 유지되는지 확인 ──
  const lifetimeAlreadyGood = '[[V3_SECTION]]이 사람의 인생에서 결국 지켜야 할 선택 원칙\n\n본문 그대로.';
  check('[평생운] 이미 정확한 제목이 나온 2차 보정 성공 케이스는 손대지 않고 그대로 반환', I.forceFinalV3SectionTitle(lifetimeAlreadyGood, I.LIFETIME_V3_FINAL_TITLE), lifetimeAlreadyGood);

  // ── 8. 회귀 확인 — 다른 5개 카테고리, NARRATIVE_V3_BASE_PROMPT, 종합사주/평생운 프롬프트
  //    텍스트 자체는 이번에 전혀 건드리지 않았는가 ──
  checkTrue('[회귀] NARRATIVE_V3_BASE_PROMPT 미변경(교차검증 원칙 유지)', I.NARRATIVE_V3_BASE_PROMPT.includes('[교차검증 원칙'));
  checkTrue('[회귀] 종합사주 프롬프트의 2차 보정 문구가 그대로 남아있음(프롬프트 자체는 3차에서 안 건드림)', I.CATEGORY_PROMPT_COMPREHENSIVE_V3.includes('토씨 하나 바꾸지 않고 정확히 그대로'));
  checkTrue('[회귀] 평생운 프롬프트의 2차 보정 문구가 그대로 남아있음', I.CATEGORY_PROMPT_LIFETIME_V3.includes('평생 선택 원칙(5개 이내) → 짧은 총평(1~2문단) → 종료'));
  checkTrue('[회귀] 재물운 고정 제목 그대로 유지됨(이번 수정 대상 아님)', I.CATEGORY_PROMPT_WEALTH_V3.includes('[[V3_SECTION]]이 사주라면 돈은 이렇게 다루는 편이 더 유리합니다'));

  console.log(`\n총 ${pass + fail}건 중 PASS ${pass} / FAIL ${fail}`);
  if (fail > 0) process.exitCode = 1;
}

main();
