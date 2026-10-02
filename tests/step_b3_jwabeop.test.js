/**
 * STEP B 신설 엔진 단위 테스트 — 좌法(坐法)
 * ─────────────────────────────────────────────────────────────
 * 핵심 발견(2026-10-02): 좌法은 "각 기둥의 지장간을, 자기 기둥의 지지가 아니라
 * 일지(日支) 위에서 기존 twelveStage(간, 일지)로 그대로 계산한 값"이다.
 * 새 테이블·보정 상수 없이 기존 twelveStage()/GAN_JANGSAENG_ZHI를 그대로 재사용한다.
 *
 * 처음엔 "음간은 장생 시작점을 1칸 당긴다"는 보정을 시도했으나, 1992-03-08 샘플의
 * 시지 午 위 양간 丙(혼천의: 衰坐)이 기존 공식(제왕)과 안 맞아 그 가정이 깨졌고,
 * 역추적한 끝에 "일지 기준 평가"라는 더 단순하고 예외 없는 규칙을 찾았다.
 *
 * 혼천의 원자료 3건(권영민 1986-10-25 남 / 1992-03-08 여 / 1990-08-03 여)의
 * 坐法 섹션 전체 — 4기둥 × 지장간 전체 33개 항목 — 와 전부 정확히 일치함을 확인한다.
 * 특정 인물(권영민) 전용 수정이 아님을 보장하기 위해 3개의 독립적인 샘플 전부에
 * 대해 end-to-end로 검증한다.
 *
 * 실행: node tests/step_b3_jwabeop.test.js
 */
const { loadEngine, makeRunner } = require('./_engine_loader');

function stageOf(jwabeopResult, pillarLabel, stemChar) {
  const p = jwabeopResult.find(x => x.pillar === pillarLabel);
  if (!p) return null;
  const h = p.hidden_stems.find(x => x.stem.includes(stemChar)); // stem은 "무(戊)" 형식(GAN_STR) — 한자로 매칭
  return h ? h.seat_stage : null;
}

function main() {
  const E = loadEngine();
  const { check, finish } = makeRunner();

  // ── 권영민 1986-10-25 03:00 대구 남 (일지=寅) ──
  {
    const s = E.calcSaju({ year: 1986, month: 10, day: 25, hour: 3, minute: 0, unknownTime: false, gender: '남', longitude: 128.60 });
    const r = E.buildJwabeop(s.pillars, s.pillars.day.g, s.pillars.day.z).jwabeop;
    const expect = {
      '년주': { '戊': '장생', '丙': '장생', '甲': '건록' },
      '월주': { '辛': '태', '丁': '사', '戊': '장생' },
      '일주': { '戊': '장생', '丙': '장생', '甲': '건록' },
      '시주': { '癸': '목욕', '辛': '태', '己': '사' },
    };
    for (const [pillar, stems] of Object.entries(expect)) {
      for (const [stem, stage] of Object.entries(stems)) {
        check(`[권영민] ${pillar} ${stem} 좌法 → ${stage}`, stageOf(r, pillar, stem), stage);
      }
    }
  }

  // ── 1992-03-08 13:00 대구 여 (일지=未) ──
  {
    const s = E.calcSaju({ year: 1992, month: 3, day: 8, hour: 13, minute: 0, unknownTime: false, gender: '여', longitude: 128.60 });
    const r = E.buildJwabeop(s.pillars, s.pillars.day.g, s.pillars.day.z).jwabeop;
    const expect = {
      '년주': { '戊': '쇠', '壬': '양', '庚': '관대' },
      '월주': { '甲': '묘', '乙': '양' },
      '일주': { '丁': '관대', '乙': '양', '己': '관대' },
      '시주': { '丙': '쇠', '己': '관대', '丁': '관대' },
    };
    for (const [pillar, stems] of Object.entries(expect)) {
      for (const [stem, stage] of Object.entries(stems)) {
        check(`[1992-03-08] ${pillar} ${stem} 좌法 → ${stage}`, stageOf(r, pillar, stem), stage);
      }
    }
  }

  // ── 1990-08-03 17:00 대구 여 (일지=子) ──
  {
    const s = E.calcSaju({ year: 1990, month: 8, day: 3, hour: 17, minute: 0, unknownTime: false, gender: '여', longitude: 128.60 });
    const r = E.buildJwabeop(s.pillars, s.pillars.day.g, s.pillars.day.z).jwabeop;
    const expect = {
      '년주': { '丙': '태', '己': '절', '丁': '절' },
      '월주': { '丁': '절', '乙': '병', '己': '절' },
      '일주': { '壬': '제왕', '癸': '건록' },
      '시주': { '戊': '태', '壬': '제왕', '庚': '사' },
    };
    for (const [pillar, stems] of Object.entries(expect)) {
      for (const [stem, stage] of Object.entries(stems)) {
        check(`[1990-08-03] ${pillar} ${stem} 좌法 → ${stage}`, stageOf(r, pillar, stem), stage);
      }
    }
  }

  // ── 합성 테스트: 시간미상이면 시주 항목이 '시간미상' note로 안전 처리되어야 한다 ──
  const unknown = E.calcSaju({ year: 1995, month: 4, day: 10, hour: 9, minute: 0, unknownTime: true, gender: '여', longitude: 128.60 });
  const rUnknown = E.buildJwabeop(unknown.pillars, unknown.pillars.day.g, unknown.pillars.day.z).jwabeop;
  const hourEntry = rUnknown.find(x => x.pillar === '시주');
  check('합성: 시간미상이면 시주 좌法은 note="시간미상", 지장간 빈 배열(크래시 없음)', !!hourEntry && hourEntry.note === '시간미상' && hourEntry.hidden_stems.length === 0, true);

  finish();
}

main();
