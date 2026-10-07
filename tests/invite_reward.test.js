/**
 * 친구 초대 보상(2026-10-07) 서버 로직 테스트 — api/interpret.js, api/share.js
 * 실제 Supabase/OpenAI 없이, PostgREST 일부 문법(eq/gte/lt/is/in/or, 유니크 충돌 409, PATCH 조건부 갱신,
 * count=exact)을 흉내 내는 메모리 DB로 아래를 검증한다.
 *  - 초대 코드 발급(비회원 지갑·복구 코드, 재호출 시 같은 코드, 로그인 계정, IP 발급 한도)
 *  - 친구 방문 기록(새 방문자만 대상, 자기 초대·기존 방문자·잘못된 코드 제외, 같은 친구 중복 기록 없음)
 *  - 보상 청구(보상 스위치, 기본운세 확인 전 보류, 지급 +1, 중복 지급 방지, 기간 만료, 초대자 하루 3회·IP 2건·하루 전체 상한,
 *    적립 실패 시 되돌림, 동시 요청 한 번만)
 *  - 초대자 알림(지갑 조회의 pendingInvite, ack 소유자 확인)
 *  - 초대받은 방문자 맛보기 2회(스위치 꺼짐·초대 없음은 1회), share.js 'ask' 카테고리
 * 실행: node tests/invite_reward.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadEngine } = require('./_engine_loader');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'interpret.js'), 'utf8');
const SHARE_SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'share.js'), 'utf8');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) pass++; else fail++;
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}` + (cond ? '' : `  ${extra || ''}`));
}
const mkRes = () => { const r = { code: null, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const resp = (status, body, headers) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => (headers || {})[k.toLowerCase()] || null }, json: async () => body, text: async () => JSON.stringify(body) });

const BASE_ENV = { OPENAI_API_KEY: 'k', SUPABASE_URL: 'https://s.test', SUPABASE_SERVICE_ROLE_KEY: 'sr', PORTONE_API_SECRET: 'ps', INVITE_REWARD_ENABLED: '1', QA_PREVIEW_DAILY_CAP: '100', QA_PREVIEW_IP_DAILY_LIMIT: '50' };

function load(env, fetchImpl) {
  const sandbox = {
    module: { exports: {} }, require, console: { log() {}, warn() {}, error() {} },
    process: { env: Object.assign({}, BASE_ENV, env || {}) }, fetch: fetchImpl, URL, URLSearchParams, setTimeout: (f) => { f(); return 0; },
    Date, JSON, Math, Buffer,
  };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { timeout: 20000 });
  return sandbox.module.exports;
}

// ---------- 메모리 DB(PostgREST 흉내) ----------
const UNIQUE = {
  qa_invites: [['code'], ['inviter_visitor_id']],
  qa_invite_rewards: [['invitee_visitor_id']],
  qa_free_usage: [['visitor_id']],
  qa_wallets: [['user_id'], ['recovery_hash']],
  qa_credit_events: [['payment_id']],
};
function matchFilter(row, key, val) {
  const [op, ...rest] = val.split('.'); const arg = rest.join('.');
  const cell = row[key];
  if (op === 'eq') return String(cell) === arg;
  if (op === 'gte') return cell != null && String(cell) >= arg;
  if (op === 'lt') return cell != null && String(cell) < arg;
  if (op === 'is') return arg === 'null' ? cell == null : cell != null;
  if (op === 'in') return arg.replace(/^\(|\)$/g, '').split(',').includes(String(cell));
  return false;
}
function rowMatches(row, params) {
  for (const [k, v] of params) {
    if (['select', 'limit', 'order'].includes(k)) continue;
    if (k === 'or') {
      const alts = v.replace(/^\(|\)$/g, '').split(',').map(a => { const i = a.indexOf('.'); return [a.slice(0, i), a.slice(i + 1)]; });
      if (!alts.some(([c, rest]) => matchFilter(row, c, rest))) return false;
      continue;
    }
    if (!matchFilter(row, k, v)) return false;
  }
  return true;
}
function makeWorld(opts) {
  opts = opts || {};
  const w = { t: {}, nid: 100, openai: 0, failCredit: false, shareRows: [], previewIds: 0 };
  const T = (name) => (w.t[name] = w.t[name] || []);
  ['qa_invites', 'qa_invite_rewards', 'funnel_events', 'qa_wallets', 'qa_credit_events', 'qa_free_usage', 'qa_question_log'].forEach(T);
  w.hasWallet = (id) => T('qa_wallets').find(x => x.id === id);
  w.fetch = async (url, init) => {
    init = init || {}; const method = init.method || 'GET';
    const prefer = (init.headers && init.headers.Prefer) || '';
    if (url.startsWith('https://api.openai.com')) { w.openai++; return resp(200, { choices: [{ message: { content: '한 줄 결론 — 좋습니다.\n\n근거 하나 — 힘이 있습니다.' } }], usage: {} }); }
    if (url.includes('/auth/v1/user')) {
      const tok = (init.headers.Authorization || '').replace('Bearer ', '');
      return tok.startsWith('tok-') ? resp(200, { id: tok.slice(4) }) : resp(401, {});
    }
    if (url.includes('/rest/v1/profiles')) return resp(200, [{ is_admin: false }]);
    if (url.includes('/rest/v1/rpc/qa_wallet_')) {
      const a = JSON.parse(init.body), fn = url.split('/rpc/')[1];
      const x = T('qa_wallets').find(q => q.id === a.p_wallet);
      if (fn === 'qa_wallet_add') { if (w.failCredit || !x) return resp(200, -1); x.balance += a.p_amount; return resp(200, x.balance); }
      if (fn === 'qa_wallet_use') { if (x && x.balance > 0) { x.balance--; return resp(200, x.balance); } return resp(200, -1); }
      if (fn === 'qa_wallet_merge') { const f = x, t = T('qa_wallets').find(q => q.id === a.p_to); if (!f || !t) return resp(200, -1); t.balance += f.balance; f.balance = 0; return resp(200, t.balance); }
    }
    const m = /\/rest\/v1\/([a-z_]+)(\?(.*))?$/.exec(url);
    if (!m) return resp(404, {});
    const table = m[1], qs = m[3] || '';
    const params = qs.split('&').filter(Boolean).map(p => { const i = p.indexOf('='); return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))]; });
    const rows = T(table);
    if (method === 'POST') {
      const b = JSON.parse(init.body);
      for (const cols of (UNIQUE[table] || [])) {
        if (cols.every(c => b[c] != null) && rows.some(r => cols.every(c => r[c] === b[c]))) return resp(409, { code: '23505' });
      }
      const row = Object.assign({ id: table === 'qa_wallets' ? 'w' + (++w.nid) : ++w.nid, created_at: new Date().toISOString() }, b);
      if (table === 'qa_invite_rewards') Object.assign(row, { granted_at: null, notified_at: null }, b);
      rows.push(row);
      return resp(201, [row]);
    }
    if (method === 'PATCH') {
      const hit = rows.filter(r => rowMatches(r, params));
      hit.forEach(r => Object.assign(r, JSON.parse(init.body)));
      return resp(200, prefer.includes('return=representation') ? hit : []);
    }
    if (method === 'DELETE') {
      const keep = rows.filter(r => !rowMatches(r, params)); rows.length = 0; keep.forEach(r => rows.push(r));
      return resp(204, {});
    }
    // GET
    let hit = rows.filter(r => rowMatches(r, params));
    const lim = params.find(p => p[0] === 'limit');
    const total = hit.length;
    if (lim) hit = hit.slice(0, parseInt(lim[1], 10));
    return resp(200, hit, prefer.includes('count=exact') ? { 'content-range': `0-0/${total}` } : {});
  };
  return w;
}
async function call(w, payload, opts) {
  opts = opts || {};
  const mod = load(opts.env, w.fetch);
  const res = mkRes();
  await mod({ method: 'POST', body: payload, headers: { 'x-forwarded-for': opts.ip || '9.9.9.9' } }, res);
  return res;
}
const create = (w, vid, extra, opts) => call(w, Object.assign({ category: 'ask', askMode: 'invite_create', visitorId: vid }, extra || {}), opts);
const visit = (w, code, vid, opts) => call(w, { category: 'ask', askMode: 'invite_visit', code, visitorId: vid }, opts);
const claim = (w, vid, opts) => call(w, { category: 'ask', askMode: 'invite_claim', visitorId: vid }, opts);
const submitEvent = (w, vid) => w.t.funnel_events.push({ id: ++w.nid, event_type: 'form_submit', visitor_id: vid, created_at: new Date().toISOString() });
const oldEvent = (w, vid) => w.t.funnel_events.push({ id: ++w.nid, event_type: 'visit', visitor_id: vid, created_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
const walletOf = (w, inviteCode) => { const inv = w.t.qa_invites.find(i => i.code === inviteCode); return w.hasWallet(inv.inviter_wallet_id); };

// 엔진으로 만든 person_profile(맛보기 호출에 필요)
const E = loadEngine();
const BIRTH = { year: 1986, month: 10, day: 25, hour: 3, minute: 3, unknownTime: false, gender: '남', longitude: 128.60 };
const PROFILE = (() => {
  const s = E.calcSaju(BIRTH), z = E.calcZiwei(BIRTH);
  const sc = E.buildSajuCore(s, { asOfDate: new Date('2026-10-02'), seunInfo: E.currentSeunInfo() });
  const zc = E.buildZiweiCore(z, { asOfDate: new Date('2026-10-02'), birthInput: BIRTH });
  return E.buildPersonProfile(sc, zc, E.buildIntegratedProfile(sc, zc)).person_profile;
})();
const previewPayload = (vid) => ({ name: '테스터', gender: '남', birth: '1990-08-20', saju: { pillars: {} }, ziwei: null, category: 'ask', askMode: 'preview', question: '올해 이직해도 될까요?', visitorId: vid, person_profile: PROFILE });

(async () => {
  let w, r, a, b;

  // ===== 초대 코드 발급 =====
  w = makeWorld();
  r = await create(w, 'inviter-1');
  check('초대 코드: 8자리, 보상 스위치 상태·새 복구 코드 반환', r.code === 200 && /^[A-HJ-NP-Z2-9]{8}$/.test(r.body.code) && r.body.rewardEnabled === true && /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(r.body.walletCode || ''), JSON.stringify(r.body));
  check('초대 코드: 비회원 지갑이 함께 만들어지고 코드 행에 연결', w.t.qa_wallets.length === 1 && w.t.qa_invites[0].inviter_wallet_id === w.t.qa_wallets[0].id && w.t.qa_wallets[0].recovery_hash);
  const CODE1 = r.body.code, WCODE1 = r.body.walletCode;
  r = await create(w, 'inviter-1', { walletCode: WCODE1 });
  check('초대 코드: 같은 방문자가 다시 요청하면 같은 코드·새 지갑 없음', r.body.code === CODE1 && r.body.walletCode === null && w.t.qa_wallets.length === 1 && w.t.qa_invites.length === 1);
  r = await create(w, '');
  check('초대 코드: 방문자 ID 없으면 400', r.code === 400);
  r = await create(w, 'bad id with spaces,(x)');
  check('초대 코드: 이상한 문자가 든 방문자 ID는 400(쿼리 주입 방지)', r.code === 400);
  w = makeWorld();
  for (let i = 0; i < 3; i++) await create(w, 'ipv' + i, null, { env: { INVITE_CREATE_IP_DAILY_LIMIT: '3' }, ip: '5.5.5.5' });
  r = await create(w, 'ipv9', null, { env: { INVITE_CREATE_IP_DAILY_LIMIT: '3' }, ip: '5.5.5.5' });
  check('초대 코드: 같은 IP에서 하루 발급 한도 초과는 429', r.code === 429 && w.t.qa_invites.length === 3);
  r = await create(w, 'ipv10', null, { env: { INVITE_CREATE_IP_DAILY_LIMIT: '3' }, ip: '6.6.6.6' });
  check('초대 코드: 다른 IP는 발급 가능', r.code === 200);
  w = makeWorld();
  r = await create(w, 'user-inviter', { access_token: 'tok-u1' });
  check('초대 코드(로그인): 계정 지갑이 만들어지고 user_id 기록, 복구 코드는 없음', r.code === 200 && r.body.loggedIn === true && r.body.walletCode === null && w.t.qa_invites[0].inviter_user_id === 'u1' && w.t.qa_wallets[0].user_id === 'u1');

  // ===== 친구 방문 기록 =====
  w = makeWorld();
  r = await create(w, 'inviter-A'); const CA = r.body.code;
  r = await visit(w, CA, 'friend-1');
  check('방문 기록: 새 방문자는 대상 + 맛보기 추가 가능', r.code === 200 && r.body.ok && r.body.eligible && r.body.bonusPreview === true && w.t.qa_invite_rewards[0].status === 'visited', JSON.stringify(r.body));
  r = await visit(w, CA, 'friend-1');
  check('방문 기록: 같은 친구를 다시 기록해도 행이 늘지 않음', r.body.eligible && w.t.qa_invite_rewards.length === 1);
  r = await visit(w, CA, 'inviter-A');
  check('방문 기록: 자기 코드로 들어오면 제외', r.body.eligible === false && r.body.reason === 'self' && w.t.qa_invite_rewards.length === 1);
  oldEvent(w, 'old-timer');
  r = await visit(w, CA, 'old-timer');
  check('방문 기록: 예전에 방문한 적 있는 사람은 보상 제외(blocked_existing)', r.body.eligible === false && r.body.reason === 'blocked_existing' && w.t.qa_invite_rewards.find(x => x.invitee_visitor_id === 'old-timer').status === 'blocked_existing');
  r = await visit(w, 'ZZZZZZZZ', 'friend-2');
  check('방문 기록: 없는 코드는 ok=false', r.body.ok === false && r.body.reason === 'bad_code');
  r = await visit(w, 'abc', 'friend-3');
  check('방문 기록: 형식이 틀린 코드는 ok=false', r.body.ok === false);
  r = await visit(w, CA, 'friend-5', { env: { INVITE_VISIT_IP_DAILY_LIMIT: '1' }, ip: '4.4.4.4' });
  b = await visit(w, CA, 'friend-6', { env: { INVITE_VISIT_IP_DAILY_LIMIT: '1' }, ip: '4.4.4.4' });
  check('방문 기록: 같은 IP에서 하루 기록 한도를 넘으면 더 기록하지 않음(rate_limited)', r.body.eligible === true && b.body.eligible === false && b.body.reason === 'rate_limited' && !w.t.qa_invite_rewards.some(x => x.invitee_visitor_id === 'friend-6'));
  r = await visit(w, CA, 'friend-4', { env: { INVITE_REWARD_ENABLED: '0' } });
  check('방문 기록(스위치 꺼짐): 기록은 하되 맛보기 추가 없음', r.body.eligible === true && r.body.bonusPreview === false && r.body.rewardEnabled === false);

  // ===== 보상 청구 =====
  w = makeWorld();
  r = await create(w, 'inv-B'); const CB = r.body.code; const wb = walletOf(w, CB);
  await visit(w, CB, 'fr-B1');
  r = await claim(w, 'fr-B1');
  check('청구: 기본운세 확인 기록 전에는 보류(지급 없음, 상태 유지)', r.body.granted === false && r.body.reason === 'pending' && wb.balance === 0 && w.t.qa_invite_rewards[0].status === 'visited');
  submitEvent(w, 'fr-B1');
  r = await claim(w, 'fr-B1');
  check('청구: 확인 완료 → 초대자 지갑 +1, 상태 granted', r.body.granted === true && wb.balance === 1 && w.t.qa_invite_rewards[0].status === 'granted' && w.t.qa_invite_rewards[0].granted_at);
  check('청구: 적립 내역에 invite_reward + 중복 방지 키', w.t.qa_credit_events.some(e => e.reason === 'invite_reward' && e.payment_id === `inv:${CB}:fr-B1` && e.delta === 1));
  check('청구: 퍼널에 invite_reward 이벤트(초대자 방문자 ID)', w.t.funnel_events.some(e => e.event_type === 'invite_reward' && e.visitor_id === 'inv-B'));
  r = await claim(w, 'fr-B1');
  check('청구: 같은 친구가 다시 청구해도 중복 지급 없음', r.body.granted === false && r.body.reason === 'already' && wb.balance === 1);
  r = await claim(w, 'stranger');
  check('청구: 초대 기록이 없는 방문자는 지급 없음', r.body.granted === false && r.body.reason === 'no_invite' && wb.balance === 1);
  // 보상 스위치
  w = makeWorld();
  r = await create(w, 'inv-C'); const CC = r.body.code; const wc = walletOf(w, CC);
  await visit(w, CC, 'fr-C1'); submitEvent(w, 'fr-C1');
  r = await claim(w, 'fr-C1', { env: { INVITE_REWARD_ENABLED: '0' } });
  check('청구(스위치 꺼짐): 지급 없음, 상태 그대로(visited)', r.body.granted === false && r.body.reason === 'disabled' && wc.balance === 0 && w.t.qa_invite_rewards[0].status === 'visited');
  r = await claim(w, 'fr-C1');
  check('청구(스위치 켠 뒤): 이전에 방문한 친구도 지급', r.body.granted === true && wc.balance === 1);
  // 만료
  w = makeWorld();
  r = await create(w, 'inv-D'); const CD = r.body.code; const wd = walletOf(w, CD);
  await visit(w, CD, 'fr-D1'); submitEvent(w, 'fr-D1');
  w.t.qa_invite_rewards[0].created_at = new Date(Date.now() - 8 * 86400000).toISOString();
  r = await claim(w, 'fr-D1');
  check('청구: 링크를 연 지 7일이 지나면 만료(지급 없음)', r.body.granted === false && r.body.reason === 'expired' && wd.balance === 0 && w.t.qa_invite_rewards[0].status === 'expired');
  // 기존 방문자 제외
  w = makeWorld();
  r = await create(w, 'inv-E'); const CE = r.body.code; const we = walletOf(w, CE);
  oldEvent(w, 'fr-E1');
  await visit(w, CE, 'fr-E1'); submitEvent(w, 'fr-E1');
  r = await claim(w, 'fr-E1');
  check('청구: 기존 방문자는 확인해도 지급 없음', r.body.granted === false && r.body.reason === 'blocked_existing' && we.balance === 0);

  // ===== 상한 =====
  w = makeWorld();
  r = await create(w, 'inv-F'); const CF = r.body.code; const wf = walletOf(w, CF);
  const results = [];
  for (let i = 1; i <= 5; i++) {
    await visit(w, CF, 'fr-F' + i, { ip: '10.0.0.' + i }); submitEvent(w, 'fr-F' + i);
    results.push((await claim(w, 'fr-F' + i, { ip: '10.0.0.' + i })).body);
  }
  check('상한(초대자): 하루 3회까지만 지급, 4·5번째는 막힘(blocked_inviter_cap)', results.map(x => x.granted).join() === 'true,true,true,false,false' && results[3].reason === 'blocked_inviter_cap' && wf.balance === 3, JSON.stringify(results));
  check('상한(초대자): 막힌 행은 granted가 아님 + 지급 내역 3건', w.t.qa_invite_rewards.filter(x => x.status === 'granted').length === 3 && w.t.qa_credit_events.filter(e => e.reason === 'invite_reward').length === 3);
  // 24시간이 지난 지급은 하루 상한에서 빠짐
  w.t.qa_invite_rewards.filter(x => x.status === 'granted').forEach(x => { x.granted_at = new Date(Date.now() - 25 * 3600000).toISOString(); });
  await visit(w, CF, 'fr-F6', { ip: '10.0.0.6' }); submitEvent(w, 'fr-F6');
  r = await claim(w, 'fr-F6', { ip: '10.0.0.6' });
  check('상한(초대자): 24시간이 지나면 다시 받을 수 있음(평생 한도 없음)', r.body.granted === true && wf.balance === 4);
  w = makeWorld();
  const envIp = { INVITE_INVITER_DAILY_LIMIT: '10' };
  r = await create(w, 'inv-G'); const CG = r.body.code; const wg = walletOf(w, CG);
  const ipRes = [];
  for (let i = 1; i <= 3; i++) { await visit(w, CG, 'fr-G' + i, { env: envIp, ip: '7.7.7.7' }); submitEvent(w, 'fr-G' + i); ipRes.push((await claim(w, 'fr-G' + i, { env: envIp, ip: '7.7.7.7' })).body); }
  check('상한(IP): 같은 IP에서 하루 2건까지만, 3번째는 막힘(blocked_ip)', ipRes.map(x => x.granted).join() === 'true,true,false' && ipRes[2].reason === 'blocked_ip' && wg.balance === 2, JSON.stringify(ipRes));
  w = makeWorld();
  const envCap = { INVITE_INVITER_DAILY_LIMIT: '10', INVITE_IP_DAILY_LIMIT: '10', INVITE_DAILY_CAP: '2' };
  r = await create(w, 'inv-H'); const CH = r.body.code; const wh = walletOf(w, CH);
  const capRes = [];
  for (let i = 1; i <= 3; i++) { await visit(w, CH, 'fr-H' + i, { env: envCap, ip: '8.8.8.' + i }); submitEvent(w, 'fr-H' + i); capRes.push((await claim(w, 'fr-H' + i, { env: envCap, ip: '8.8.8.' + i })).body); }
  check('상한(하루 전체): 설정한 수를 넘으면 막힘(blocked_daily_cap)', capRes.map(x => x.granted).join() === 'true,true,false' && capRes[2].reason === 'blocked_daily_cap' && wh.balance === 2, JSON.stringify(capRes));

  // ===== 적립 실패 · 동시 요청 · 로그인 초대자 =====
  w = makeWorld();
  r = await create(w, 'inv-I'); const CI = r.body.code; const wi = walletOf(w, CI);
  await visit(w, CI, 'fr-I1'); submitEvent(w, 'fr-I1');
  w.failCredit = true;
  r = await claim(w, 'fr-I1');
  check('적립 실패: 지급 안 됨 + 상태를 visited로 되돌려 다시 시도 가능', r.body.granted === false && r.body.reason === 'credit_failed' && w.t.qa_invite_rewards[0].status === 'visited' && wi.balance === 0 && w.t.qa_credit_events.length === 0);
  w.failCredit = false;
  r = await claim(w, 'fr-I1');
  check('적립 실패 뒤 재시도: 정상 지급', r.body.granted === true && wi.balance === 1);
  w = makeWorld();
  r = await create(w, 'inv-J'); const CJ = r.body.code; const wj = walletOf(w, CJ);
  await visit(w, CJ, 'fr-J1'); submitEvent(w, 'fr-J1');
  const both = await Promise.all([claim(w, 'fr-J1'), claim(w, 'fr-J1'), claim(w, 'fr-J1')]);
  check('동시 청구 3건: 정확히 한 번만 지급', both.filter(x => x.body.granted).length === 1 && wj.balance === 1 && w.t.qa_credit_events.filter(e => e.reason === 'invite_reward').length === 1, JSON.stringify(both.map(x => x.body)));
  w = makeWorld();
  r = await create(w, 'inv-K', { access_token: 'tok-ukk' }); const CK = r.body.code;
  w.t.qa_wallets[0].balance = 1;
  await visit(w, CK, 'fr-K1'); submitEvent(w, 'fr-K1');
  r = await claim(w, 'fr-K1');
  check('로그인 초대자: 계정 지갑에 적립(1→2)', r.body.granted === true && w.t.qa_wallets[0].balance === 2);

  // ===== 초대자 알림(토스트) =====
  w = makeWorld();
  r = await create(w, 'inv-L'); const CL = r.body.code; const WL = r.body.walletCode;
  await visit(w, CL, 'fr-L1'); submitEvent(w, 'fr-L1'); await claim(w, 'fr-L1');
  await visit(w, CL, 'fr-L2', { ip: '3.3.3.3' }); submitEvent(w, 'fr-L2'); await claim(w, 'fr-L2', { ip: '3.3.3.3' });
  r = await call(w, { category: 'ask', askMode: 'wallet', walletCode: WL, visitorId: 'inv-L' });
  check('알림: 지갑 조회에 안 본 보상 개수·잔액이 함께 옴', r.code === 200 && r.body.balance === 2 && r.body.pendingInvite.count === 2 && r.body.pendingInvite.ids.length === 2, JSON.stringify(r.body));
  const ids = r.body.pendingInvite.ids;
  r = await call(w, { category: 'ask', askMode: 'invite_ack', visitorId: 'someone-else', ids });
  check('알림 완료: 다른 사람은 남의 보상을 알림 처리할 수 없음', r.body.acked === 0 && w.t.qa_invite_rewards.every(x => !x.notified_at));
  r = await call(w, { category: 'ask', askMode: 'invite_ack', visitorId: 'inv-L', ids });
  check('알림 완료: 초대자 본인이 호출하면 notified_at 기록', r.body.acked === 2 && w.t.qa_invite_rewards.filter(x => x.status === 'granted').every(x => x.notified_at));
  r = await call(w, { category: 'ask', askMode: 'wallet', walletCode: WL, visitorId: 'inv-L' });
  check('알림 완료 후: 같은 보상은 다시 나오지 않음', r.body.pendingInvite.count === 0);
  r = await call(w, { category: 'ask', askMode: 'wallet', walletCode: WL });
  check('지갑 조회: 방문자 ID 없이도 기존처럼 동작(pendingInvite 0)', r.code === 200 && r.body.balance === 2 && r.body.pendingInvite.count === 0);

  // ===== 초대받은 방문자 맛보기 2회 =====
  w = makeWorld();
  r = await create(w, 'inv-M'); const CM = r.body.code;
  await visit(w, CM, 'fr-M1');
  a = await call(w, previewPayload('fr-M1'));
  b = await call(w, previewPayload('fr-M1'));
  r = await call(w, previewPayload('fr-M1'));
  check('맛보기: 초대받은 새 방문자는 2회까지(세 번째는 막힘)', a.code === 200 && b.code === 200 && r.code === 429 && r.body.code === 'visitor_used' && w.openai === 2, `${a.code} ${b.code} ${r.code}`);
  check('맛보기: 두 번째 사용 기록은 별도 행(#inv)', w.t.qa_free_usage.map(x => x.visitor_id).sort().join() === 'fr-M1,fr-M1#inv');
  a = await call(w, previewPayload('plain-1'));
  b = await call(w, previewPayload('plain-1'));
  check('맛보기: 초대와 무관한 방문자는 기존대로 1회', a.code === 200 && b.code === 429 && b.body.code === 'visitor_used');
  oldEvent(w, 'fr-M2'); await visit(w, CM, 'fr-M2');
  a = await call(w, previewPayload('fr-M2')); b = await call(w, previewPayload('fr-M2'));
  check('맛보기: 기존 방문자가 초대 링크로 들어와도 추가 없음', a.code === 200 && b.code === 429);
  await visit(w, CM, 'fr-M3', { env: { INVITE_REWARD_ENABLED: '0' } });
  a = await call(w, previewPayload('fr-M3'), { env: { INVITE_REWARD_ENABLED: '0' } }); b = await call(w, previewPayload('fr-M3'), { env: { INVITE_REWARD_ENABLED: '0' } });
  check('맛보기(스위치 꺼짐): 초대 방문자도 추가 없음', a.code === 200 && b.code === 429);
  w.t.qa_invite_rewards.find(x => x.invitee_visitor_id === 'fr-M1').created_at = new Date(Date.now() - 9 * 86400000).toISOString();
  w.t.qa_free_usage = w.t.qa_free_usage.filter(x => x.visitor_id !== 'fr-M1#inv');
  r = await call(w, previewPayload('fr-M1'));
  check('맛보기: 초대 기간(7일)이 지나면 추가 없음', r.code === 429);

  // ===== invite_config(화면 문구용 — DB 무접촉) =====
  r = await call(w, { category: 'ask', askMode: 'invite_config' });
  check('invite_config: 스위치 켜짐 → rewardEnabled true', r.code === 200 && r.body.rewardEnabled === true, JSON.stringify(r.body));
  r = await call(w, { category: 'ask', askMode: 'invite_config' }, { env: { INVITE_REWARD_ENABLED: '0' } });
  check('invite_config: 스위치 꺼짐 → rewardEnabled false', r.code === 200 && r.body.rewardEnabled === false, JSON.stringify(r.body));

  // ===== share.js ask 카테고리 =====
  {
    const rows = [];
    const sandbox = { module: { exports: {} }, require, console: { log() {}, error() {} }, process: { env: { SUPABASE_URL: 'https://s.test', SUPABASE_SERVICE_ROLE_KEY: 'sr' } },
      fetch: async (url, init) => { rows.push(JSON.parse(init.body)); return resp(201, []); }, URL };
    sandbox.exports = sandbox.module.exports; vm.createContext(sandbox); vm.runInContext(SHARE_SRC, sandbox);
    const res1 = mkRes();
    await sandbox.module.exports({ method: 'POST', body: { category: 'ask', name: '', excerpt: '하반기에 흐름이 좋아집니다.' } }, res1);
    check('share.js: ask 카테고리로 공유 카드 저장(질문·이름 없음)', res1.code === 200 && rows[0].category === 'ask' && rows[0].sender_name === '' && rows[0].excerpt === '하반기에 흐름이 좋아집니다.', JSON.stringify(rows));
  }

  console.log(`\n총 ${pass + fail}건 중 PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})();
