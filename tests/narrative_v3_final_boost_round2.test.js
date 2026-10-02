/**
 * Narrative V3 "최종 보정 2차"(2026-10-02, 사용자 추가 지시) 검증.
 *
 * 1차 "최종 보정"(narrative_v3_final_boost.test.js) 이후 실제 결제 플로우로 재생성한 7개
 * PDF를 사람이 직접 리뷰한 결과, 종합사주/평생운 프리미엄 2개 카테고리에서 다음 문제가
 * 발견됐다:
 *   - 종합사주: 마지막 고정 제목("지금 이 사람에게 가장 중요한 선택 기준")이 실제 큰 제목으로
 *     나오지 않고, 본문 문장 속에 섞여서만 한 번 언급됨(원인: [큰 제목 구성]이 "4~5개" 폭을
 *     허용하면서 권장 5번째 제목을 "건강·현재시기 총평"으로 제시해, 마지막 고정 제목과 자리가
 *     충돌했음).
 *   - 평생운 프리미엄: 마지막 고정 제목이 아예 다른 문장("결국 이 사람은 구조를 고를 때 운이
 *     살아납니다")으로 나왔고, 그 뒤에 청소년기/20대 회고 같은 새 내용이 더 이어 붙어 17페이지
 *     까지 늘어남(원인: needsContinuation()의 흐름 커버리지 휴리스틱이 마지막 고정 제목이 이미
 *     쓰인 뒤에도 "아직 부족"으로 오판해 이어쓰기를 한 번 더 호출함).
 *
 * 이번 수정(연애·재회운/취업·사업·이동운/재물운/신년운세/궁합&결혼 5개 카테고리와
 * NARRATIVE_V3_BASE_PROMPT는 건드리지 않음)은 (1) 종합사주 [큰 제목 구성]을 5개 고정 + 마지막
 * 슬롯 전용으로 재구성하고 고정 제목 지시를 강화했고, (2) 평생운 마지막 고정 제목 지시를
 * "선택 원칙 → 짧은 총평 → 종료" 순서로 강화했고, (3) needsContinuation()에 "마지막 고정
 * 제목이 이미 텍스트에 있으면 분량/흐름 커버리지와 무관하게 이어쓰기를 멈춘다"는 하드 가드를
 * 추가했다. 여기서는 (1)(2)는 프롬프트 문자열 검증, (3)은 하드 가드가 참조하는 상수가 실제
 * 카테고리 프롬프트의 고정 제목과 정확히 일치하는지로 간접 검증한다(핸들러 내부 클로저라
 * 직접 호출은 불가 — 실제 동작은 결제 플로우 재생성으로 별도 확인 필요).
 *
 * 실행: node tests/narrative_v3_final_boost_round2.test.js
 */
const { loadInterpretModule } = require('./_interpret_loader');
const { loadEngine } = require('./_engine_loader');

function main() {
  const I = loadInterpretModule();
  const E = loadEngine();
  let pass = 0, fail = 0;
  function checkTrue(label, cond) {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}`);
    if (cond) pass++; else fail++;
  }

  // ── 1. 종합사주: [큰 제목 구성]이 5개 고정 + 마지막 슬롯 전용으로 재구성됐는가 ──
  const comp = I.CATEGORY_PROMPT_COMPREHENSIVE_V3;
  checkTrue('[종합사주] 큰 제목이 "5개"로 고정됨(4~5개 폭 허용 문구 제거)', comp.includes('큰 제목 반드시 5개로 나눕니다'));
  checkTrue('[종합사주] 건강·현재시기 내용이 4번째 제목 안으로 합쳐짐(5번째와 자리 충돌 제거)', comp.includes('반드시 4번째 제목 안에 넣으세요'));
  checkTrue('[종합사주] 마지막 고정 제목에 "토씨 하나 바꾸지 않고 정확히" 지시가 추가됨', comp.includes('토씨 하나 바꾸지 않고 정확히 그대로'));
  checkTrue('[종합사주] "본문 문장 속에 섞어서 언급하는 것 금지" 지시가 명시됨', comp.includes('본문 중간 문장 속에 섞어서'));
  checkTrue('[종합사주] "이 섹션 뒤에는 새 대주제·장문 해석 금지" 지시가 명시됨', comp.includes('이 섹션 뒤에는 새로운 대주제나 장문 해석을 절대 추가하지 않습니다'));
  checkTrue('[종합사주] 고정 제목 문자열이 COMPREHENSIVE_V3_FINAL_TITLE 상수와 정확히 일치', comp.includes('[[V3_SECTION]]' + I.COMPREHENSIVE_V3_FINAL_TITLE));

  // ── 2. 평생운 프리미엄: 마지막 고정 제목 지시가 "선택 원칙 → 짧은 총평 → 종료"로 강화됐는가 ──
  const life = I.CATEGORY_PROMPT_LIFETIME_V3;
  checkTrue('[평생운] 고정 제목 문자열이 LIFETIME_V3_FINAL_TITLE 상수와 정확히 일치', life.includes('[[V3_SECTION]]' + I.LIFETIME_V3_FINAL_TITLE));
  checkTrue('[평생운] "토씨 하나 바꾸지 않고 정확히" 지시가 추가됨', life.includes('토씨 하나 바꾸지 않고 정확히 그대로 고정 제목'));
  checkTrue('[평생운] 실제로 나왔던 잘못된 변형 제목이 금지 예시로 명시됨', life.includes('결국 이 사람은 구조를 고를 때 운이 살아납니다'));
  checkTrue('[평생운] "선택 원칙 → 짧은 총평 → 종료" 순서가 명시됨', life.includes('평생 선택 원칙(5개 이내) → 짧은 총평(1~2문단) → 종료'));
  checkTrue('[평생운] 고정 제목 이후 과거 회고·성격 재분석·반복·새 소주제 금지가 명시됨', life.includes('이후 절대 금지') && life.includes('청소년기·20대 이야기를 다시 꺼내는 것'));
  checkTrue('[평생운] 분량 미달보다 "이후 절대 금지" 규칙이 우선한다는 명시가 있음', life.includes('분량 미달보다 [마지막 큰 제목 — 행동 추천서]의 "이후 절대 금지" 규칙이 항상 우선'));
  checkTrue('[평생운] 권장 분량이 9,500~12,000자로 더 낮아짐(1차 보정의 10,000~13,000자에서 재하향)', life.includes('권장 분량은 9,500~12,000자'));
  checkTrue('[평생운] 최대 분량이 약 13,000자로 더 낮아짐(1차 보정의 약 14,000자에서 재하향)', life.includes('최대 약 13,000자를 넘기지 않습니다'));
  checkTrue('[평생운] 제목당 평균 분량이 1,200~1,600자로 낮아짐(1차 보정의 1,400~1,900자에서 재하향)', life.includes('평균 1,200~1,600자'));
  checkTrue('[평생운] [성공/실패 기준]에 제목 변형·후속 서사 금지가 실패 사례로 추가됨', life.includes('토씨가 다른 제목으로 바뀌어 나온다') && life.includes('과거 회고·성격 재분석 같은 새 내용이 더 이어진다'));

  // ── 3. 수정 원칙 준수 — 다른 5개 카테고리 프롬프트와 NARRATIVE_V3_BASE_PROMPT는 건드리지 않았는가 ──
  checkTrue('[회귀 확인] NARRATIVE_V3_BASE_PROMPT에 여전히 교차검증 원칙 섹션이 포함됨(미변경 확인)', I.NARRATIVE_V3_BASE_PROMPT.includes('[교차검증 원칙'));
  checkTrue('[회귀 확인] NARRATIVE_V3_BASE_PROMPT에 여전히 행동 추천서 공통 규칙이 포함됨(미변경 확인)', I.NARRATIVE_V3_BASE_PROMPT.includes('행동 추천서'));
  const loveUnchanged = I.buildCategoryPromptLoveV3('general');
  checkTrue('[회귀 확인] 연애운 고정 제목 그대로 유지됨(이번 수정 대상 아님)', loveUnchanged.includes('[[V3_SECTION]]이 사주라면 연애에서는 이렇게 행동하는 편이 더 낫습니다'));
  checkTrue('[회귀 확인] 재물운 고정 제목 그대로 유지됨(이번 수정 대상 아님)', I.CATEGORY_PROMPT_WEALTH_V3.includes('[[V3_SECTION]]이 사주라면 돈은 이렇게 다루는 편이 더 유리합니다'));
  checkTrue('[회귀 확인] 신년운세 고정 제목 그대로 유지됨(이번 수정 대상 아님)', I.CATEGORY_PROMPT_NEWYEAR_V3.includes('[[V3_SECTION]]올해는 이렇게 움직이면 흐름을 더 잘 살릴 수 있습니다'));
  const careerUnchanged = I.buildCategoryPromptCareerV3('employed');
  checkTrue('[회귀 확인] 취업사업운 고정 제목 그대로 유지됨(이번 수정 대상 아님)', careerUnchanged.includes('[[V3_SECTION]]이 사주라면 일은 이렇게 선택하는 편이 더 낫습니다'));
  const compatUnchanged = I.buildCategoryPromptCompatibilityV3('권영민', '테스트상대');
  checkTrue('[회귀 확인] 궁합 고정 제목 그대로 유지됨(이번 수정 대상 아님)', compatUnchanged.includes('[[V3_SECTION]]두 사람이 오래 가려면 실제로 이렇게 맞추는 편이 낫습니다'));

  // ── 4. buildPrompt() 전체 조립이 여전히 크래시 없이 동작하는가(두 카테고리 모두) ──
  // interpret_narrative_block.test.js와 동일하게 실제 엔진으로 권영민 fixture person_profile을
  // 만들어서 쓴다(가짜 빈 객체는 buildPersonProfileNarrativeBlock이 기대하는 하위 필드가 없어
  // 이 테스트와 무관한 이유로 크래시하므로, 실제 조립 경로를 그대로 재현하는 쪽을 쓴다).
  const birthInput = { year: 1986, month: 10, day: 25, hour: 3, minute: 3, unknownTime: false, gender: '남', longitude: 128.60 };
  const sajuForPrompt = E.calcSaju(birthInput);
  const ziweiForPrompt = E.calcZiwei(birthInput);
  const sajuCoreForPrompt = E.buildSajuCore(sajuForPrompt, { asOfDate: new Date('2026-10-02'), seunInfo: E.currentSeunInfo() });
  const ziweiCoreForPrompt = E.buildZiweiCore(ziweiForPrompt, { asOfDate: new Date('2026-10-02'), birthInput });
  const integratedForPrompt = E.buildIntegratedProfile(sajuCoreForPrompt, ziweiCoreForPrompt);
  const ppForPrompt = E.buildPersonProfile(sajuCoreForPrompt, ziweiCoreForPrompt, integratedForPrompt).person_profile;
  const basePayload = {
    name: '권영민', gender: '남', birth: '1986-10-25 03:03',
    saju: { 년주: '병인', 월주: '무술', 일주: '임인', 시주: '신축', 일간: '임(壬)', 오행분포: '(테스트)', 공망: '진사' },
    ziwei: { 음력생일: '(테스트)', 오행국: '화육국', 명궁: '병신' },
    person_profile: ppForPrompt,
  };
  let compPromptOk = true, lifePromptOk = true;
  try { I.buildPrompt({ ...basePayload, category: 'comprehensive' }); } catch (e) { compPromptOk = false; console.error('  comprehensive 에러:', e.message); }
  try { I.buildPrompt({ ...basePayload, category: 'lifetime' }); } catch (e) { lifePromptOk = false; console.error('  lifetime 에러:', e.message); }
  checkTrue('buildPrompt(category=comprehensive)이 크래시 없이 동작함', compPromptOk);
  checkTrue('buildPrompt(category=lifetime)이 크래시 없이 동작함', lifePromptOk);

  console.log(`\n총 ${pass + fail}건 중 PASS ${pass} / FAIL ${fail}`);
  if (fail > 0) process.exitCode = 1;
}

main();
