/**
 * STEP B 신설 엔진 단위 테스트 — 천간합충 / 신살·귀인 / 세운 wiring
 * ─────────────────────────────────────────────────────────────
 * 세 가지를 각각 특정 인물 전용이 아닌 "함수/테이블 단위" 테스트로 검증한다:
 *
 *  1) 천간합충 테이블 테스트 — buildGanRelations()의 오합/사충 테이블이 임의의
 *     합성 천간 배열에 대해 올바르게 동작하는지(합/충 모두 아닌 경우 포함).
 *  2) 신살 룰 테이블 테스트 — buildGuiinShinsal()의 귀인 5종 테이블이 임의의
 *     합성 입력에 대해 올바르게 동작하는지.
 *  3) 세운 전달(wiring) 테스트 — currentSeunInfo()가 올해 연도의 세운 간지를
 *     실제로 만들어내고, buildSajuCore({seunInfo})에 넘기면 timing.seun이
 *     더 이상 null이 아님을 확인한다(과거엔 opts.seunInfo를 아무도 넘기지 않아
 *     항상 null이었다).
 *
 * 혼천의 원자료 3건(권영민/1992-03-08/1990-08-03)과의 end-to-end 교차검증은
 * STEP_A_자미두수_시지기준_원인확정_수정완료.md 및 STEP B 완료 보고서에 별도로 기록.
 *
 * 실행: node tests/step_b_engines.test.js
 */
const { loadEngine, makeRunner, ZHI, GAN } = require('./_engine_loader');

function main() {
  const E = loadEngine();
  const { check, finish } = makeRunner();

  // ── 1) 천간합충 테이블 테스트 (함수 단위, 특정 인물과 무관) ──
  // 甲(0)己(5)합토, 甲(0)庚(6)충 — 인접 여부와 상관없이 "탐지"는 모두 이뤄져야 한다.
  // 년간甲-시간庚 충은 일부러 뺀 별도 조합(일간丁/월간己)으로 "합이 충에 안 깨진 깨끗한 케이스"를 테스트
  const r1 = E.buildGanRelations([{label:'년간',g:0},{label:'월간',g:5},{label:'일간',g:3},{label:'시간',g:1}]).gan_relations;
  check('천간합충: 년간甲-월간己 합(토) 탐지', r1.combinations.some(c=>c.pair==='년간甲-월간己' && c.result_element==='토'), true);
  check('천간합충: 충이 전혀 섞이지 않은 인접 합(년-월)은 미판정', r1.combinations.find(c=>c.pair==='년간甲-월간己').transformation_status, '미판정');

  // 충 탐지는 비인접 쌍에서도 이뤄져야 한다(년-시, 사이에 월/일이 끼어 있어도 탐지)
  const r1b = E.buildGanRelations([{label:'년간',g:0},{label:'월간',g:2},{label:'일간',g:4},{label:'시간',g:6}]).gan_relations;
  check('천간합충: 년간甲-시간庚 충 탐지(비인접이어도 탐지)', r1b.clashes.some(c=>c.pair==='년간甲-시간庚'), true);

  // 戊(4)癸(9)합화 — 비인접(월-시)이면 grade C, 성립가능성낮음
  const r2 = E.buildGanRelations([{label:'년간',g:2},{label:'월간',g:4},{label:'일간',g:1},{label:'시간',g:9}]).gan_relations;
  const combo = r2.combinations.find(c=>c.pair==='월간戊-시간癸');
  check('천간합충: 비인접 합(월-시)은 grade C + 성립가능성낮음', !!combo && combo.grade==='C' && combo.transformation_status==='성립가능성낮음', true);

  // 戊(4)/己(5)는 충이 없다(중앙토) — 어떤 조합으로도 충이 나오면 안 된다
  const r3 = E.buildGanRelations([{label:'년간',g:4},{label:'월간',g:5},{label:'일간',g:0},{label:'시간',g:1}]).gan_relations;
  check('천간합충: 戊·己는 사충 체계에 없음(충 0건)', r3.clashes.length, 0);

  // 아무 관계도 없는 조합(甲·乙·丙·丁 — 서로 합·충 짝이 전혀 아님) — 둘 다 빈 배열
  const r4 = E.buildGanRelations([{label:'년간',g:0},{label:'월간',g:1},{label:'일간',g:2},{label:'시간',g:3}]).gan_relations;
  check('천간합충: 합·충 관계가 전혀 없으면 둘 다 빈 배열', r4.combinations.length===0 && r4.clashes.length===0, true);

  // ── 2) 신살 룰 테이블 테스트 (함수 단위) ──
  // 일간 甲(0) → 천을귀인은 丑(1)/未(7). 지지에 丑이 있으면 탐지되어야 한다.
  const sh1 = E.buildGuiinShinsal(0, 2, 2, { year:{g:0,z:2}, month:{g:0,z:2}, day:{g:0,z:1}, hour:null }).guiin_shinsal;
  check('신살: 甲일간 + 丑 지지 보유 → 천을귀인 탐지(일주)', sh1.some(s=>s.name==='천을귀인' && s.pillar==='일주'), true);

  // 일간 壬(8) → 문창귀인은 寅(2). 지지에 寅이 전혀 없으면 탐지되면 안 된다.
  const sh2 = E.buildGuiinShinsal(8, 4, 4, { year:{g:8,z:4}, month:{g:8,z:4}, day:{g:8,z:5}, hour:{g:8,z:7} }).guiin_shinsal;
  check('신살: 壬일간인데 寅 지지가 전혀 없으면 문창귀인 미탐지', sh2.some(s=>s.name==='문창귀인'), false);

  // 월지 戌(10) → 삼합국 寅午戌, 월덕귀인=丙(2). 천간에 丙이 있으면 탐지.
  const sh3 = E.buildGuiinShinsal(8, 10, 10, { year:{g:2,z:2}, month:{g:4,z:10}, day:{g:8,z:2}, hour:{g:7,z:1} }).guiin_shinsal;
  check('신살: 월지 戌(삼합 寅午戌) + 년간 丙 보유 → 월덕귀인 탐지(년주)', sh3.some(s=>s.name==='월덕귀인' && s.pillar==='년주'), true);

  // 금여록: 戊/己 일간은 confidence가 C로 낮아야 한다(건록 기준 학파차 반영)
  const sh4 = E.buildGuiinShinsal(4, 4, 4, { year:{g:4,z:4}, month:{g:4,z:4}, day:{g:4,z:7}, hour:null }).guiin_shinsal; // 戊일간, 금여=未(7)
  const geumyeo = sh4.find(s=>s.name==='금여록');
  check('신살: 戊일간 금여록은 confidence C(건록 기준 학파차)', !!geumyeo && geumyeo.confidence==='C', true);

  // ── 3) 세운 전달(wiring) 테스트 ──
  const seun = E.currentSeunInfo();
  check('세운: currentSeunInfo()는 올해 연도를 그대로 반환', seun.year, new Date().getFullYear());
  check('세운: currentSeunInfo()는 g/z를 숫자로 채움', typeof seun.g === 'number' && typeof seun.z === 'number', true);

  const sajuResult = E.calcSaju({ year:1986, month:10, day:25, hour:3, minute:0, unknownTime:false, gender:'남', longitude:128.60 });
  const coreWithSeun = E.buildSajuCore(sajuResult, { asOfDate: new Date('2026-10-02'), seunInfo: E.currentSeunInfo() });
  check('세운: opts.seunInfo를 넘기면 timing.seun.year가 더 이상 null이 아님', coreWithSeun.timing.seun.year !== null, true);
  const coreWithoutSeun = E.buildSajuCore(sajuResult, { asOfDate: new Date('2026-10-02') });
  check('세운: opts.seunInfo를 안 넘기면 여전히 timing.seun.year=null(기존 동작 보존, 회귀 없음)', coreWithoutSeun.timing.seun.year, null);

  // ── 4) 引從法(인종法) — 선택 규칙 미확정 표시 테스트 ──
  // 포태법 산출 메커니즘은 검증됐지만 "어느 십성을 인종 대상으로 볼지" 선택 규칙이
  // 혼천의 샘플 간 모순되어(2026-10-02 사용자 지시: "모순되면 억지 구현 금지, 규칙
  // 미확정으로 표시") 구체적인 인종 대상을 출력하지 않고 상태만 노출해야 한다.
  const inj = E.buildInjongbeop().injongbeop;
  check('引從法: 선택 규칙 미확정 상태로 표시(구체 결과 미출력)', inj.status, '규칙 미확정');

  finish();
}

main();
