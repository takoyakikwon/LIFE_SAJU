/**
 * STEP C 신설 보조성 단위 테스트 — 天馬 / 地劫 / 地空
 * ─────────────────────────────────────────────────────────────
 * 天馬: 년지 삼합국 기준(바자의 驛馬와 동일한 지지 산출 공식).
 * 地空/地劫: "亥에서 子시 기준, 地空은 역행·地劫은 순행" 공식.
 *
 * 혼천의 원자료 3건(권영민 1986-10-25 남 / 1992-03-08 여 / 1990-08-03 여) 전부와
 * 대조해 9/9(3개 보조성 × 3샘플) 전부 일치를 확인했다. 이 테스트는 그 세 fixture에 대한
 * end-to-end 재확인 + 임의의 합성 입력에 대한 공식 자체 검증을 함께 수행한다.
 *
 * 실행: node tests/step_c_aux_stars.test.js
 */
const { loadEngine, makeRunner, ZHI } = require('./_engine_loader');

function findAux(ziweiResult, name) {
  const s = ziweiResult.auxStars.find(a => a.name === name);
  return s ? ZHI[s.stdZhi] : null;
}

function main() {
  const E = loadEngine();
  const { check, finish } = makeRunner();

  const fixtures = [
    { name: '권영민 1986-10-25 03:00 대구 남', input: { year:1986, month:10, day:25, hour:3, minute:0, unknownTime:false, gender:'남', longitude:128.60 }, expect: { 천마:'申', 지공:'酉', 지겁:'丑' } },
    { name: '1992-03-08 13:00 대구 여', input: { year:1992, month:3, day:8, hour:13, minute:0, unknownTime:false, gender:'여', longitude:128.60 }, expect: { 천마:'寅', 지공:'辰', 지겁:'午' } },
    { name: '1990-08-03 17:00 대구 여', input: { year:1990, month:8, day:3, hour:17, minute:0, unknownTime:false, gender:'여', longitude:128.60 }, expect: { 천마:'申', 지공:'寅', 지겁:'申' } },
  ];

  for (const fx of fixtures) {
    const sajuResult = E.calcSaju(fx.input);
    const ziweiResult = E.calcZiwei({ year:fx.input.year, month:fx.input.month, day:fx.input.day, hour:fx.input.hour, minute:fx.input.minute, unknownTime:fx.input.unknownTime, gender:fx.input.gender, trueHourFloat: sajuResult.trueHourFloat, sajuYear: sajuResult.sajuYear });
    check(`[${fx.name}] 天馬`, findAux(ziweiResult, '천마'), fx.expect.천마);
    check(`[${fx.name}] 地空`, findAux(ziweiResult, '지공'), fx.expect.지공);
    check(`[${fx.name}] 地劫`, findAux(ziweiResult, '지겁'), fx.expect.지겁);
  }

  // 합성 테스트: 시간미상이어도 地空/地劫은 (기존 화성/영성과 같은 관례로) 子시 기준 참고값으로 계산되어야 한다
  const unknown = E.calcZiwei({ year:1995, month:4, day:10, hour:9, minute:0, unknownTime:true, gender:'여', trueHourFloat: null, sajuYear: 1995 });
  check('합성: 시간미상이어도 地空/地劫은 子시 기준 참고값으로 계산(크래시 없음)', findAux(unknown, '지공') === '亥' && findAux(unknown, '지겁') === '亥', true);

  finish();
}

main();
