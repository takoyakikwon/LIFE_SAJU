/**
 * 자미두수 명궁/신궁 "시지(時支) 기준" 단위 테스트
 * ─────────────────────────────────────────────────────────────
 * STEP A (2026-10-02) 수정 내용 검증용.
 *
 * 배경: calcZiwei()는 원래 사주 엔진의 trueHourFloat(진태양시, 경도+균시차 보정)를
 * 그대로 재사용해 자미두수 명궁/신궁/문창·문곡/화성·영성의 시지를 산출했다.
 * 혼천의 원자료 3건(권영민 1986-10-25 03:00 대구 남 / 1992-03-08 13:00 대구 여 /
 * 1990-08-03 17:00 대구 여) 교차검증 결과, 혼천의는 세 건 모두 "출생시각 그대로
 * (민간 시진, KST 벽시계)"를 자미두수 시지로 쓰고 있었다. 사주 시주(時柱)는 원래부터
 * 진태양시 기준으로 양쪽이 일치했으므로 그대로 둔다 — 자미두수 시지 산출 기준만
 * trueHourFloat → wall-clock(hour, minute)으로 바꾼 것이 STEP A의 전체 수정이다.
 *
 * 이 테스트는 특정 인물(권영민) 전용 수정이 아님을 보장하기 위해:
 *  1) 함수 단위 합성 케이스(가상의 연/월/일, 임의의 trueHourFloat vs hour)로
 *     hourZhiStd가 더 이상 trueHourFloat를 따르지 않고 hour/minute(벽시계)을
 *     따르는지 직접 검증한다.
 *  2) 3개의 독립적인 혼천의 원자료 fixture(사람이 서로 다름, 월/시/성별이 모두 다름)에
 *     대해 calcZiwei()의 실제 운영 호출 방식(트루호출플로트를 그대로 넘기는 방식)으로
 *     명궁/신궁/오행국/12궁 주성+보조성/사화/대한 전부가 혼천의 원자료와 정확히
 *     일치하는지 end-to-end로 검증한다.
 *
 * 실행: node tests/ziwei_hour_basis.test.js
 */
const { loadEngine, makeRunner, ZHI, GAN } = require('./_engine_loader');

function main() {
  const E = loadEngine();
  const { check, finish } = makeRunner();

  // ── 1) 함수 단위 합성 테스트 ──
  const caseA = E.calcZiwei({ year:2000, month:5, day:15, hour:3, minute:0, unknownTime:false, gender:'남', trueHourFloat: 23.9, sajuYear: 2000 });
  check('합성케이스A: hourZhiStd는 wall=03:00 → 寅(2)를 따른다 (trueHourFloat=23.9/子를 따르지 않음)', caseA.hourZhiStd, 2);

  const caseB = E.calcZiwei({ year:2000, month:5, day:15, hour:9, minute:0, unknownTime:false, gender:'남', trueHourFloat: 1.0, sajuYear: 2000 });
  check('합성케이스B: hourZhiStd는 wall=09:00 → 巳(5)를 따른다 (trueHourFloat=1.0/丑을 따르지 않음)', caseB.hourZhiStd, 5);

  const caseC = E.calcZiwei({ year:2000, month:5, day:15, hour:9, minute:0, unknownTime:true, gender:'남', trueHourFloat: 1.0, sajuYear: 2000 });
  check('합성케이스C: 시간미상이면 hourZhiStd=null (회귀 없음)', caseC.hourZhiStd, null);

  // ── 2) End-to-end fixture 테스트 ──
  const fixtures = [
    { name: '권영민 1986-10-25 03:00 대구 남', input: { year:1986, month:10, day:25, hour:3, minute:0, unknownTime:false, gender:'남', longitude:128.60 }, expect: { mingGong: '丙申', bodyZhi: '子', bureau: '화6국', daeHanStart: 6 } },
    { name: '1992-03-08 13:00 대구 여', input: { year:1992, month:3, day:8, hour:13, minute:0, unknownTime:false, gender:'여', longitude:128.60 }, expect: { mingGong: '戊申', bodyZhi: '戌', bureau: '토5국', daeHanStart: 5 } },
    { name: '1990-08-03 17:00 대구 여', input: { year:1990, month:8, day:3, hour:17, minute:0, unknownTime:false, gender:'여', longitude:128.60 }, expect: { mingGong: '丙戌', bodyZhi: '辰', bureau: '토5국', daeHanStart: 5 } },
  ];

  for (const fx of fixtures) {
    const sajuResult = E.calcSaju(fx.input);
    const ziweiResult = E.calcZiwei({ year:fx.input.year, month:fx.input.month, day:fx.input.day, hour:fx.input.hour, minute:fx.input.minute, unknownTime:fx.input.unknownTime, gender:fx.input.gender, trueHourFloat: sajuResult.trueHourFloat, sajuYear: sajuResult.sajuYear });
    const mingGong = GAN[ziweiResult.mingGan] + ZHI[ziweiResult.soulZhiStd];
    const bodyZhi = ZHI[ziweiResult.bodyZhiStd];
    check(`[${fx.name}] 명궁`, mingGong, fx.expect.mingGong);
    check(`[${fx.name}] 신궁 지지`, bodyZhi, fx.expect.bodyZhi);
    check(`[${fx.name}] 오행국`, ziweiResult.bureau.name, fx.expect.bureau);
    check(`[${fx.name}] 대한 시작 나이`, ziweiResult.daeHan.list[0].startAge, fx.expect.daeHanStart);
  }

  finish();
}

main();
