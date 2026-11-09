/**
 * 부적 구매(2026-11) 서버 로직 테스트 — api/interpret.js (category:'talisman') + api/_talisman.js
 * 실제 Supabase/PortOne 없이 가짜 fetch 로 검증한다.
 * 실행: node tests/talisman.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const API = path.join(__dirname, '..', 'api');
const SRC = fs.readFileSync(path.join(API, 'interpret.js'), 'utf8');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) pass++; else fail++;
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}` + (cond ? '' : `  ${extra || ''}`));
}
const mkRes = () => { const r = { code: null, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });

function setup({ paid = {}, rows = [] } = {}) {
  const db = rows.slice();
  const inserts = [];
  const fetchImpl = async (url, opts) => {
    url = String(url);
    if (url.startsWith('https://api.portone.io/payments/')) {
      const id = decodeURIComponent(url.split('/payments/')[1]);
      if (!paid[id]) return resp(404, { type: 'PAYMENT_NOT_FOUND' });
      return resp(200, { status: paid[id].status || 'PAID', amount: { total: paid[id].total } });
    }
    if (url.startsWith('https://s.test/rest/v1/purchases')) {
      if (!opts || !opts.method || opts.method === 'GET') {
        const q = new URL(url).searchParams;
        const pid = (q.get('payment_id') || '').replace(/^eq\./, '');
        const cat = (q.get('category') || '').replace(/^eq\./, '');
        const hit = db.filter((r) => r.payment_id === pid && (!cat || r.category === cat) && r.status === 'paid');
        return resp(200, hit.map((r) => ({ id: r.id || 1, payload: r.payload, created_at: r.created_at })));
      }
      const body = JSON.parse(opts.body);
      inserts.push(body); db.push(Object.assign({ created_at: new Date().toISOString() }, body));
      return resp(201, {});
    }
    return resp(404, {});
  };
  const sandbox = {
    module: { exports: {} }, require: (p) => (p.startsWith('./') ? require(path.join(API, p)) : require(p)),
    console: { log() {}, warn() {}, error() {} },
    process: { env: { OPENAI_API_KEY: 'k', SUPABASE_URL: 'https://s.test', SUPABASE_SERVICE_ROLE_KEY: 'sr', PORTONE_API_SECRET: 'ps' } },
    fetch: fetchImpl, URL, URLSearchParams, setTimeout: (f) => { f(); return 0; }, Date, JSON, Math, Buffer,
  };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { timeout: 20000 });
  return { handler: sandbox.module.exports, db, inserts };
}
async function call(handler, payload) {
  const res = mkRes();
  await handler({ method: 'POST', body: payload, headers: {} }, res);
  return res;
}
const GOOD = { category: 'talisman', paymentId: 'pay_1700000000000_abcdef12', visitorId: 'v1', talisman: { kind: 'wealth', el: '金', purpose: 'biz' } };

(async () => {
  // 1) 정상 구매
  let t = setup({ paid: { [GOOD.paymentId]: { total: 1900 } } });
  let r = await call(t.handler, GOOD);
  check('정상 결제: 200 + 부적 SVG', r.code === 200 && r.body.kind === 'talisman' && r.body.svg.startsWith('<svg') && r.body.svg.includes('<path d="M'), JSON.stringify(r.body).slice(0, 120));
  check('구매 기록: category=talisman, 금액 1900, 결제번호 저장', t.inserts.length === 1 && t.inserts[0].category === 'talisman' && t.inserts[0].amount === 1900 && t.inserts[0].payment_id === GOOD.paymentId, JSON.stringify(t.inserts));
  check('구매 기록 payload 에 종류·오행·목적 저장', t.inserts[0].payload.talisman.kind === 'wealth' && t.inserts[0].payload.talisman.el === '金' && t.inserts[0].payload.talisman.purposeKey === 'biz');
  check('응답에 15일 만료 시각', !!r.body.expiresAt && (new Date(r.body.expiresAt) - new Date(r.body.createdAt)) === 15 * 86400000);

  // 2) 같은 결제로 다시 요청: 값이 달라도 처음 기록된 부적만 나온다(새 부적 추가 불가)
  const r2 = await call(t.handler, Object.assign({}, GOOD, { talisman: { kind: 'pass', el: '水', purpose: 'univ' } }));
  check('같은 결제 재요청: 처음 기록된 부적(재물)이 그대로', r2.code === 200 && r2.body.talismanKind === 'wealth' && r2.body.again === true && t.inserts.length === 1);
  const r2b = await call(t.handler, { category: 'talisman', mode: 'view', paymentId: GOOD.paymentId });
  check('mode=view 재열람: 같은 이미지', r2b.code === 200 && r2b.body.svg === r.body.svg);

  // 3) 결제 실패/금액 불일치/미결제
  t = setup({ paid: { [GOOD.paymentId]: { total: 900 } } });
  r = await call(t.handler, GOOD);
  check('금액 불일치(900원): 402, 기록 없음', r.code === 402 && t.inserts.length === 0, r.code);
  t = setup({ paid: { [GOOD.paymentId]: { total: 1900, status: 'READY' } } });
  r = await call(t.handler, GOOD);
  check('결제 미완료(READY): 402', r.code === 402);
  t = setup({ paid: {} });
  r = await call(t.handler, GOOD);
  check('없는 결제번호: 402', r.code === 402);

  // 4) 다른 상품에 이미 쓴 결제번호
  t = setup({ paid: { [GOOD.paymentId]: { total: 1900 } }, rows: [{ payment_id: GOOD.paymentId, category: 'ask_pack', status: 'paid', payload: {} }] });
  r = await call(t.handler, GOOD);
  check('다른 상품에 쓰인 결제번호: 409', r.code === 409, r.code);

  // 5) 입력 검사
  t = setup({ paid: { [GOOD.paymentId]: { total: 1900 } } });
  for (const bad of [{ kind: 'x', el: '金', purpose: 'biz' }, { kind: 'wealth', el: '金', purpose: 'zzz' }, { kind: 'wealth', el: 'A', purpose: 'biz' }, { kind: 'match', el: '水', el2: '?' }, { kind: 'pass', el: '木', purpose: 'univ', date: '2027-13-40' }, { kind: 'pass', el: '木', purpose: 'univ', date: '<script>' }]) {
    r = await call(t.handler, Object.assign({}, GOOD, { talisman: bad }));
    check('잘못된 선택 400: ' + JSON.stringify(bad), r.code === 400 && t.inserts.length === 0, r.code);
  }
  r = await call(t.handler, Object.assign({}, GOOD, { paymentId: 'x' }));
  check('결제번호 형식 오류 400', r.code === 400);

  // 6) 15일 지난 부적
  const old = new Date(Date.now() - 16 * 86400000).toISOString();
  t = setup({ rows: [{ payment_id: GOOD.paymentId, category: 'talisman', status: 'paid', created_at: old, payload: { talisman: { kind: 'pass', el: '木', purposeKey: 'univ', year: 2026, date: null } } }] });
  r = await call(t.handler, { category: 'talisman', mode: 'view', paymentId: GOOD.paymentId });
  check('15일 지나면 410', r.code === 410, r.code);
  r = await call(t.handler, { category: 'talisman', mode: 'view', paymentId: 'pay_unknown_12345678' });
  check('없는 결제 재열람 404', r.code === 404, r.code);

  // 7) 궁합(두 인장)·합격(날짜)
  const pid2 = 'pay_1700000000001_zzzzzzzz';
  t = setup({ paid: { [pid2]: { total: 1900 } } });
  r = await call(t.handler, { category: 'talisman', paymentId: pid2, talisman: { kind: 'match', el: '水', el2: '火' } });
  check('궁합 부적: 두 오행 인장', r.code === 200 && r.body.el === '水' && r.body.el2 === '火' && r.body.purposeLabel === null);
  const pid3 = 'pay_1700000000002_yyyyyyyy';
  t = setup({ paid: { [pid3]: { total: 1900 } } });
  r = await call(t.handler, { category: 'talisman', paymentId: pid3, talisman: { kind: 'pass', el: '木', purpose: 'exam', date: '2027-11-18' } });
  check('합격 부적: 시험일이 이미지에 새겨짐', r.code === 200 && r.body.svg.includes('2027 · 11 · 18'));

  // 8) 생성기 전체 조합이 모두 만들어진다
  const T = require(path.join(API, '_talisman.js'));
  let n = 0, okAll = true;
  for (const k of T.KIND_KEYS) for (const p of Object.keys(T.PURPOSES[k])) for (const el of T.ELEMENTS) for (const e2 of (k === 'match' ? T.ELEMENTS : [null])) {
    try { const s = T.buildTalismanSvg({ kind: k, el, el2: e2, purpose: p, year: 2026 }); if (!s.startsWith('<svg') || s.includes('undefined') || s.includes('NaN')) okAll = false; n++; } catch (e) { okAll = false; }
  }
  check(`부적 ${n}가지 조합이 모두 생성됨(undefined/NaN 없음)`, okAll && n === 4 * 5 + 4 * 5 + 25, n);
  check('같은 입력은 같은 이미지(결정적)', T.buildTalismanSvg({ kind: 'pass', el: '木', purpose: 'univ', year: 2026 }) === T.buildTalismanSvg({ kind: 'pass', el: '木', purpose: 'univ', year: 2026 }));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
