/**
 * Narrative V3 "최종 보정"(2026-10-02 작업지시서: 사주결_Narrative_V3_최종보정_행동추천서_포함_작업지시서.md) 검증.
 *
 * 이 작업지시서는 계산 엔진을 전혀 건드리지 않고 Narrative layer(NARRATIVE_V3_BASE_PROMPT +
 * 7개 CATEGORY_PROMPT_*_V3)만 수정하므로, 여기서는 실제 OpenAI 호출 없이 "프롬프트 문자열에
 * 요구된 규칙이 실제로 들어갔는가"만 정적으로 검증한다(순수 문자열 조립 결과 확인 — 네트워크 없음).
 * 모델이 그 지시를 실제로 얼마나 잘 따르는지는 이 테스트의 범위 밖이며, 실제 결제 플로우를 통한
 * 재생성 결과로 별도 확인해야 한다(작업지시서 12번 "작업 완료 보고" 참고).
 *
 * 실행: node tests/narrative_v3_final_boost.test.js
 */
const { loadInterpretModule } = require('./_interpret_loader');

function main() {
  const I = loadInterpretModule();
  let pass = 0, fail = 0;
  function checkTrue(label, cond) {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}`);
    if (cond) pass++; else fail++;
  }

  // ── 1. 공통 BASE_PROMPT: 행동 추천서 규칙이 실제로 들어갔는가 ──
  const base = I.NARRATIVE_V3_BASE_PROMPT;
  checkTrue('[BASE] 마지막 섹션이 더 이상 "총평"이 아니라 "행동 추천서"로 재정의됨', base.includes('행동 추천서'));
  checkTrue('[BASE] 네 관점(지금 더 해도 되는 것 등)이 명시됨', base.includes('지금 더 해도 되는 것') && base.includes('줄이는 것이 좋은 것') && base.includes('선택할 때 우선할 기준') && base.includes('지금 시기에서 특히 중요한 행동'));
  checkTrue('[BASE] 추천 형식(행동→이유→기대되는 변화)이 명시됨', base.includes('행동 → 이유 → 기대되는 변화'));
  checkTrue('[BASE] 금지된 막연한 조언 문구가 명시됨(전문가와 상의/무리하지 마세요 등)', base.includes('전문가와 상의하세요') && base.includes('무리하지 마세요'));
  checkTrue('[BASE] 단정 표현 금지("반드시/무조건") + 완곡 표현 예시("더 유리합니다")가 명시됨', base.includes('무조건') && base.includes('더 유리합니다'));
  checkTrue('[BASE] 반복 방지 목록에 새 핵심 문구(버틴다/기준이 강하다 등)가 추가됨', base.includes('"버틴다"') && base.includes('"기준이 강하다"') && base.includes('"구조를 정리한다"'));
  checkTrue('[BASE] 같은 핵심 문구 2~3회 초과 반복 금지 규칙이 명시됨', base.includes('2~3회 넘게 반복하지 않습니다'));
  // 기존 테스트(interpret_narrative_block.test.js)가 의존하는 라벨이 이번 수정으로 깨지지
  // 않았는지도 여기서 한 번 더 교차 확인(회귀 방지 — 이번 수정 범위가 바로 옆 섹션이었음).
  checkTrue('[BASE] (회귀 확인) [교차검증 원칙 라벨이 그대로 유지됨', base.includes('[교차검증 원칙'));

  // ── 2. 카테고리별 고정 마지막 섹션 제목 — 작업지시서 6번 "카테고리별 최종 수정 지시" 그대로 ──
  const EXPECTED_TITLES = {
    comprehensive: '[[V3_SECTION]]지금 이 사람에게 가장 중요한 선택 기준',
    wealth: '[[V3_SECTION]]이 사주라면 돈은 이렇게 다루는 편이 더 유리합니다',
    lifetime: '[[V3_SECTION]]이 사람의 인생에서 결국 지켜야 할 선택 원칙',
    newyear: '[[V3_SECTION]]올해는 이렇게 움직이면 흐름을 더 잘 살릴 수 있습니다',
    love: '[[V3_SECTION]]이 사주라면 연애에서는 이렇게 행동하는 편이 더 낫습니다',
    career: '[[V3_SECTION]]이 사주라면 일은 이렇게 선택하는 편이 더 낫습니다',
    compatibility: '[[V3_SECTION]]두 사람이 오래 가려면 실제로 이렇게 맞추는 편이 낫습니다',
  };
  checkTrue('[comprehensive] 고정 마지막 섹션 제목 포함', I.CATEGORY_PROMPT_COMPREHENSIVE_V3.includes(EXPECTED_TITLES.comprehensive));
  checkTrue('[wealth] 고정 마지막 섹션 제목 포함', I.CATEGORY_PROMPT_WEALTH_V3.includes(EXPECTED_TITLES.wealth));
  checkTrue('[lifetime] 고정 마지막 섹션 제목 포함', I.CATEGORY_PROMPT_LIFETIME_V3.includes(EXPECTED_TITLES.lifetime));
  checkTrue('[newyear] 고정 마지막 섹션 제목 포함', I.CATEGORY_PROMPT_NEWYEAR_V3.includes(EXPECTED_TITLES.newyear));
  const lovePrompt = I.buildCategoryPromptLoveV3('general');
  checkTrue('[love] 고정 마지막 섹션 제목 포함(함수형, loveStatus=general)', lovePrompt.includes(EXPECTED_TITLES.love));
  const careerPrompt = I.buildCategoryPromptCareerV3('employed');
  checkTrue('[career] 고정 마지막 섹션 제목 포함(함수형, jobStatus=employed)', careerPrompt.includes(EXPECTED_TITLES.career));
  const compatPrompt = I.buildCategoryPromptCompatibilityV3('권영민', '테스트상대');
  checkTrue('[compatibility] 고정 마지막 섹션 제목 포함(함수형, 이름 주입)', compatPrompt.includes(EXPECTED_TITLES.compatibility));
  checkTrue('[compatibility] 두 사람 이름이 실제로 치환되어 들어감(익명 "사람 A/B" 금지 지시와 함께)', compatPrompt.includes('권영민') && compatPrompt.includes('테스트상대') && compatPrompt.includes('사람 A'));

  // ── 3. 카테고리별 "핵심 질문 우선" 보강 — 작업지시서 11번 QA 기준과 맞춰 추가한 문구 확인 ──
  checkTrue('[wealth] 첫 페이지 2개 이상 커버리지 요구 문구 포함', I.CATEGORY_PROMPT_WEALTH_V3.includes('최소 2개에 대해 이미 구체적인 입장'));
  checkTrue('[career] 첫 2페이지 커버리지 요구 문구 포함', careerPrompt.includes('첫 2페이지 안에 아래 중 최소 2개'));
  checkTrue('[love] 첫 20~30% 커버리지 요구 문구 포함(최소 3개)', lovePrompt.includes('최소 3개에 이미 구체적인 입장'));
  checkTrue('[compatibility] 첫 1~2페이지 결혼 가능성 요약 + 점수화 금지 문구 포함', compatPrompt.includes('결혼까지 갈 수 있는 관계인지') && compatPrompt.includes('점수화하지 않습니다'));
  checkTrue('[newyear] 첫 페이지 연도+핵심변화 명시 요구 문구 포함', I.CATEGORY_PROMPT_NEWYEAR_V3.includes('해당 연도(2027년)와 올해 가장 중요한 변화'));

  // ── 4. 평생운 프리미엄 분량 압축(19페이지 → 13~15페이지 목표) ──
  checkTrue('[lifetime] 절대 최소 분량이 9,000자로 하향됨', I.CATEGORY_PROMPT_LIFETIME_V3.includes('절대 최소 9,000자'));
  checkTrue('[lifetime] 최대 분량이 약 14,000자로 하향됨(기존 약 20,000자)', I.CATEGORY_PROMPT_LIFETIME_V3.includes('최대 약 14,000자'));
  checkTrue('[lifetime] "반복되는 해석을 합치라"는 압축 지침(삭제/축소 대상)이 포함됨', I.CATEGORY_PROMPT_LIFETIME_V3.includes('반복되는 해석을 합치라'));
  checkTrue('[lifetime] MIN_LENGTH_BY_CATEGORY.lifetime === 9000(서버 이어쓰기 기준도 동기화됨)', I.MIN_LENGTH_BY_CATEGORY.lifetime === 9000);
  checkTrue('[lifetime] MAX_CONTINUATION_ROUNDS_BY_CATEGORY.lifetime === 2(기존 3에서 하향)', I.MAX_CONTINUATION_ROUNDS_BY_CATEGORY.lifetime === 2);

  console.log(`\n총 ${pass + fail}건 중 PASS ${pass} / FAIL ${fail}`);
  if (fail > 0) process.exitCode = 1;
}

main();
