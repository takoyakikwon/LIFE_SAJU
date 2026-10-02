/**
 * STEP E 보정 — 지지 관계 라벨/반합 분리 & 자미두수 주성 강도(廟/旺/得/陷 등)
 * ─────────────────────────────────────────────────────────────
 * 2026-10-02 사용자(챗GPT 경유) 지시에 따른 2개 보정 항목의 단위/fixture 테스트.
 *
 *  1) 지지 관계: 丑戌 형은 혼천의 표기 그대로 "축술형(無禮)"으로 라벨링하고,
 *     혼천의 RAW(八字關係)에 나타나지 않는 寅戌 반합(B급 후보)은 혼천의 호환
 *     relations에서 제외하고 saju_core.experimental_relations(내부 연구용,
 *     myeongri_evidence에는 전달 안 함)로 분리한다.
 *  2) 자미두수 주성 강도: 혼천의 RAW로 직접 확인된 14개 (별,지지) 조합만 등급을
 *     채우고, 나머지는 null("미확인")로 — 전체 14×12 고전표를 추측으로 채우지
 *     않는다. life_palace/body_palace의 main_star_grades로 노출.
 *
 * 권영민 fixture(1986-10-25 양력 03:03 대구 남)의 혼천의 RAW와 1:1 대조:
 *   八字關係: 時-月 丑戌刑(無禮) / 時-年 辛丙合水 / 日-年 壬丙沖
 *   命盤: 兄弟乙未(紫微廟,破軍廟) 夫妻甲午(天機陷化權) 財帛壬辰(太陽旺)
 *         疾厄辛卯(武曲陷,七殺旺) 遷移庚寅(天同得化祿,天梁廟) 交友辛丑(天相廟)
 *         官祿·身庚子(巨門旺) 田宅己亥(廉貞陷化忌,貪狼陷) 福德戊戌(太陰廟)
 *         父母丁酉(天府廟) / 命宮丙申(空宮)
 *
 * 실행: node tests/step_e_fixes.test.js
 */
const { loadEngine } = require('./_engine_loader');

function main() {
  const E = loadEngine();
  let pass = 0, fail = 0;
  function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}` + (ok ? '' : `  실제=${JSON.stringify(actual)} 기대=${JSON.stringify(expected)}`));
    if (ok) pass++; else fail++;
  }

  const birthInput = { year: 1986, month: 10, day: 25, hour: 3, minute: 3, unknownTime: false, gender: '남', longitude: 128.60 };

  // ── 1) 지지 관계: 丑戌刑(無禮) 라벨 + 寅戌반합 분리 ──
  const s = E.calcSaju(birthInput);
  const core = E.buildSajuCore(s, { asOfDate: new Date('2026-10-02') });
  const rel = core.saju_core.relations;
  const exp = core.saju_core.experimental_relations;

  check('[권영민] 지지관계: 丑戌형 라벨이 혼천의 표기 그대로 "축술형(無禮)"',
    rel.punishments.some(p => p.pair.includes('축술형(無禮)')), true);
  check('[권영민] 지지관계: 혼천의 호환 combinations에는 寅戌반합이 없음(제외됨)',
    rel.combinations.length, 0);
  check('[권영민] 지지관계: 寅戌반합은 experimental_relations로 분리 보존됨',
    exp.combinations.some(c => c.type === '반합'), true);
  check('[권영민] 천간관계: 時-年 辛丙合水 탐지(결과오행=수)',
    core.saju_core.gan_relations.combinations.some(c => c.pair === '년간丙-시간辛' && c.result_element === '수'), true);
  check('[권영민] 천간관계: 日-年 壬丙沖 탐지',
    core.saju_core.gan_relations.clashes.some(c => c.pair === '년간丙-일간壬'), true);
  check('[권영민] 引從法: 여전히 "규칙 미확정"으로만 표시(이번 보정 대상 아님)',
    core.saju_core.injongbeop.status, '규칙 미확정');

  // ── 2) 자미두수 주성 강도 — 혼천의 RAW 12궁 전부와 대조 ──
  const z = E.calcZiwei(birthInput);
  function gradeOf(palaceName, hanja) {
    const p = z.palaces.find(pp => pp.name === palaceName);
    const st = p && p.stars.find(ss => ss.hanja === hanja);
    return st ? st.grade : undefined;
  }
  const expectGrades = [
    ['형제궁', '紫微', '廟'], ['형제궁', '破軍', '廟'],
    ['부처궁', '天機', '陷'],
    ['재백궁', '太陽', '旺'],
    ['질액궁', '武曲', '陷'], ['질액궁', '七殺', '旺'],
    ['천이궁', '天同', '得'], ['천이궁', '天梁', '廟'],
    ['교우궁', '天相', '廟'],
    ['관록궁', '巨門', '旺'],
    ['전택궁', '廉貞', '陷'], ['전택궁', '貪狼', '陷'],
    ['복덕궁', '太陰', '廟'],
    ['부모궁', '天府', '廟'],
  ];
  expectGrades.forEach(([palace, hanja, grade]) => {
    check(`[권영민] 자미 주성강도: ${palace} ${hanja} → ${grade}`, gradeOf(palace, hanja), grade);
  });
  check('[권영민] 자미 주성강도: 명궁은 空宮이라 주성 없음(빈 배열)',
    z.palaces.find(p => p.name === '명궁').stars.filter(s => expectGrades.some(e => e[1] === s.hanja)).length, 0);
  check('[권영민] 자미 주성강도: 보조성(文昌 등)은 주성 강도 체계 대상이 아니므로 grade 필드 자체가 없음(추측 금지)',
    gradeOf('명궁', '文昌'), undefined);

  // ── 3) myeongri_evidence/main_star_grades — life_palace(명궁)/body_palace(관록궁) ──
  const zc = E.buildZiweiCore(z, { asOfDate: new Date('2026-10-02'), birthInput });
  check('[권영민] life_palace(명궁) main_star_grades: 空宮이라 빈 배열',
    zc.ziwei_core.life_palace.main_star_grades, []);
  check('[권영민] body_palace(관록궁=身宮) main_star_grades: 거문 旺',
    zc.ziwei_core.body_palace.main_star_grades, [{ name: '거문', grade: '旺' }]);

  console.log(`\n총 ${pass + fail}건 중 PASS ${pass} / FAIL ${fail}`);
  if (fail > 0) process.exitCode = 1;
}

main();
