/**
 * STEP6 재연결 — buildPersonProfileNarrativeBlock()이 STEP A~E에서 새로 검증된 엔진 필드
 * (천간합충/지지관계/신살귀인/통근투간/공망/세운/삼방사정/사화/주성강도)를 실제로 Narrative
 * 프롬프트에 연결하는지, 그리고 引從法(injongbeop)은 어떤 경로로도 노출되지 않는지를 검증한다.
 *
 * 혼천의 원자료 권영민 fixture(1986-10-25 양력 03:03 대구 남)로 end-to-end 검증하고,
 * 출생시간 미상 합성 입력으로 자미두수 쪽 교차근거(삼방사정/사화/주성강도)가 올바르게
 * 생략되는지도 함께 확인한다.
 *
 * 실행: node tests/interpret_narrative_block.test.js
 */
const { loadInterpretModule } = require('./_interpret_loader');
const { loadEngine } = require('./_engine_loader');

function main() {
  const I = loadInterpretModule();
  const E = loadEngine();
  let pass = 0, fail = 0;
  function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}` + (ok ? '' : `  실제=${JSON.stringify(actual)} 기대=${JSON.stringify(expected)}`));
    if (ok) pass++; else fail++;
  }
  function checkTrue(label, cond) {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}`);
    if (cond) pass++; else fail++;
  }

  function makePP(birthInput) {
    const s = E.calcSaju(birthInput);
    const z = E.calcZiwei(birthInput);
    const sajuCore = E.buildSajuCore(s, { asOfDate: new Date('2026-10-02'), seunInfo: E.currentSeunInfo() });
    const ziweiCore = E.buildZiweiCore(z, { asOfDate: new Date('2026-10-02'), birthInput });
    const integrated = E.buildIntegratedProfile(sajuCore, ziweiCore);
    return E.buildPersonProfile(sajuCore, ziweiCore, integrated).person_profile;
  }

  // ── 권영민 fixture: 새로 연결된 교차검증 근거가 실제로 나타나는지 ──
  const birthInput = { year: 1986, month: 10, day: 25, hour: 3, minute: 3, unknownTime: false, gender: '남', longitude: 128.60 };
  const pp = makePP(birthInput);
  const block = I.buildPersonProfileNarrativeBlock(pp);

  checkTrue('[권영민] 천간합충이 명리 근거에 연결됨(년간丙-일간壬 충)', block.includes('년간丙-일간壬 충'));
  checkTrue('[권영민] 지지관계가 연결됨(축술형 無禮)', block.includes('축술형(無禮)'));
  checkTrue('[권영민] 신살/귀인이 연결됨(천덕귀인)', block.includes('천덕귀인'));
  checkTrue('[권영민] 통근/투간 등급이 연결됨', block.includes('통근/투간:'));
  checkTrue('[권영민] 주성 강도가 연결됨(신궁 거문 旺)', block.includes('신궁 거문(旺)'));
  checkTrue('[권영민] 삼방사정이 연결됨', block.includes('삼방사정'));
  checkTrue('[권영민] 사화가 연결됨', block.includes('사화:'));
  checkTrue('[권영민] 명궁 空宮이 빈 값이 아니라 "공궁(空宮)"으로 표시됨', block.includes('명궁=공궁(空宮)'));

  // ── 引從法은 이 session의 명시적 지시(2026-10-02): "최종 AI evidence에 사용하지 않는다" ──
  checkTrue('[권영민] 引從法/injongbeop 문자열이 Narrative 블록 어디에도 없음', !block.includes('injongbeop') && !block.includes('引從法') && !block.includes('규칙 미확정'));

  // myeongri_evidence 자체에 injongbeop 필드가 있어도(saju_core 레벨 참고용) 이 narrative
  // 블록을 만드는 함수가 그 필드를 절대 읽지 않는다는 것도 직접 확인 — 일부러 injongbeop에
  // 눈에 띄는 가짜 값을 심어도 출력에 영향이 없어야 한다(= 코드가 실제로 그 필드를 참조하지
  // 않는다는 증거).
  const ppWithFakeInjongbeop = JSON.parse(JSON.stringify(pp));
  ppWithFakeInjongbeop.myeongri_evidence.saju.injongbeop = { status: '테스트용-절대노출금지-마커' };
  const blockWithFake = I.buildPersonProfileNarrativeBlock(ppWithFakeInjongbeop);
  checkTrue('[권영민] injongbeop 필드에 가짜 마커를 심어도 출력에 전혀 나타나지 않음(코드가 실제로 그 필드를 안 읽음)', !blockWithFake.includes('테스트용-절대노출금지-마커'));

  // ── 성립하지 않은 신호는 올리지 않는다 — 가짜로 전부 비워서 교차근거 섹션 자체가 생략되는지 확인 ──
  const ppEmpty = JSON.parse(JSON.stringify(pp));
  ppEmpty.myeongri_evidence.saju.gan_relations = { combinations: [], clashes: [] };
  ppEmpty.myeongri_evidence.saju.relations = { combinations: [], clashes: [], punishments: [], harms: [], breaks: [] };
  ppEmpty.myeongri_evidence.saju.guiin_shinsal = [];
  ppEmpty.myeongri_evidence.saju.voids = { natal_void: { status: '미작동', pillar_hit: null }, daeun_void_activation: [], seun_void_activation: [] };
  ppEmpty.myeongri_evidence.saju.current_seun = null;
  ppEmpty.myeongri_evidence.saju.roots_and_stems = { tongkeun_grade: null, tongkeun_detail: null };
  ppEmpty.myeongri_evidence.ziwei.san_fang_si_zheng = { supporting_signals: [], conflicting_signals: [] };
  ppEmpty.myeongri_evidence.ziwei.sihwa = [];
  ppEmpty.myeongri_evidence.ziwei.main_star_grades = { life_palace: [], body_palace: [] };
  const emptyEvidence = I.formatMyeongriCrossEvidence(ppEmpty.myeongri_evidence, true);
  check('빈 신호만 있으면 교차근거 목록이 완전히 비어야 함(억지로 채우지 않음)', emptyEvidence, []);

  // ── 출생시간 미상: 자미두수 쪽(삼방사정/사화/주성강도)은 생략, 사주 쪽은 유지 ──
  const unknownInput = { year: 1995, month: 4, day: 10, hour: 9, minute: 0, unknownTime: true, gender: '여', longitude: 128.60 };
  const ppUnknown = makePP(unknownInput);
  const evidenceUnknown = I.formatMyeongriCrossEvidence(ppUnknown.myeongri_evidence, false);
  checkTrue('[시간미상] 삼방사정/사화/주성강도 등 자미 쪽 교차근거는 전혀 생성되지 않음', !evidenceUnknown.some(l => l.startsWith('삼방사정') || l.startsWith('사화') || l.startsWith('주성 강도')));

  // ── buildPrompt() 전체 조립이 크래시 없이 동작하는지(와 injongbeop이 최종 프롬프트 어디에도 없는지) ──
  const payload = {
    name: '권영민', gender: '남', birth: '1986-10-25 03:03', category: 'wealth',
    saju: { 년주: '병인', 월주: '무술', 일주: '임인', 시주: '신축', 일간: '임(壬)', 오행분포: '(테스트)', 공망: '진사' },
    ziwei: { 음력생일: '(테스트)', 오행국: '화육국', 명궁: '병신' },
    person_profile: pp,
  };
  const fullPrompt = I.buildPrompt(payload);
  checkTrue('buildPrompt() 전체 조립이 크래시 없이 문자열을 반환함', typeof fullPrompt === 'string' && fullPrompt.length > 0);
  checkTrue('최종 프롬프트 어디에도 引從法/injongbeop이 없음', !fullPrompt.includes('injongbeop') && !fullPrompt.includes('引從法'));
  // 교차검증 원칙은 buildPrompt()의 반환값(사용자 데이터 블록)이 아니라 시스템 프롬프트
  // (NARRATIVE_V3_BASE_PROMPT)에 들어있다 — module.exports가 SYSTEM_PROMPT = NARRATIVE_V3_BASE_PROMPT
  // + 카테고리 프롬프트로 합쳐서 실제 호출에 쓴다. 여기서는 그 상수 자체를 직접 확인한다.
  checkTrue('NARRATIVE_V3_BASE_PROMPT(시스템 프롬프트)에 교차검증 원칙 섹션이 포함됨', I.NARRATIVE_V3_BASE_PROMPT.includes('[교차검증 원칙'));

  console.log(`\n총 ${pass + fail}건 중 PASS ${pass} / FAIL ${fail}`);
  if (fail > 0) process.exitCode = 1;
}

main();
