// Vercel 서버리스 함수: 카카오톡 공유 시 "받는 사람이 보낸 사람의 심층풀이 총평 일부를
// 미리 볼 수 있게" 하기 위한 공유 토큰 발급/조회 전용 엔드포인트 (2026-09-25 신규).
//
// - POST: 방금 생성된 심층풀이 결과에서 클라이언트가 미리 추출한 짧은 총평(excerpt)을 받아
//   result_shares 테이블에 저장하고, 무작위 토큰을 발급한다.
// - GET: 토큰으로 그 미리보기(카테고리·이름·총평)를 공개 조회한다(로그인 불필요 — 카카오톡으로
//   링크를 받은 누구나 볼 수 있어야 하므로).
//
// 결과 원문 전체나 생년월일시 같은 개인 식별 정보는 이 테이블에 전혀 저장하지 않는다 —
// 저장/노출되는 건 카테고리·이름(선택 입력, 최대 20자)·짧은 총평 텍스트(최대 220자)뿐이다.
// 클라이언트가 보낸 값을 그대로 믿지 않고, 길이/카테고리 화이트리스트로 서버가 다시 제한한다.
//
// 사전 준비: Supabase에 아래 테이블이 있어야 한다(README/개발현황.md 참고).
//   create table public.result_shares (
//     id uuid primary key default gen_random_uuid(),
//     token text unique not null,
//     category text not null,
//     sender_name text,
//     excerpt text not null,
//     created_at timestamptz not null default now()
//   );
//   alter table public.result_shares enable row level security;
// (서버가 서비스 롤 키로 직접 접근하므로 별도 RLS 정책은 두지 않는다 — recordPurchase/checkIsAdmin과 동일한 패턴.)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VALID_CATEGORIES = ['comprehensive', 'love', 'compatibility', 'newyear', 'wealth', 'pet', 'career'];
const MAX_EXCERPT_LEN = 220;
const MAX_NAME_LEN = 20;

function makeToken() {
  // 짧고 URL에 넣기 편한 무작위 토큰(영숫자 12자) — 추측하기 어렵도록 crypto 기반 난수를 쓴다.
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = require('crypto').randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += chars[bytes[i] % chars.length];
  return out;
}

module.exports = async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: '서버에 SUPABASE 환경변수가 설정되어 있지 않습니다.' });
    return;
  }

  if (req.method === 'POST') {
    let payload;
    try {
      payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (e) {
      res.status(400).json({ error: '요청 본문을 해석할 수 없습니다.' });
      return;
    }
    const category = VALID_CATEGORIES.includes(payload && payload.category) ? payload.category : 'comprehensive';
    const name = String((payload && payload.name) || '').trim().slice(0, MAX_NAME_LEN);
    const excerpt = String((payload && payload.excerpt) || '').trim().slice(0, MAX_EXCERPT_LEN);
    if (!excerpt) {
      res.status(400).json({ error: '공유할 내용이 없습니다.' });
      return;
    }
    const token = makeToken();
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/result_shares`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Prefer': 'return=minimum',
        },
        body: JSON.stringify({ token, category, sender_name: name, excerpt }),
      });
      if (!r.ok) {
        const errText = await r.text();
        console.error('result_shares insert failed', r.status, errText);
        res.status(500).json({ error: '공유 링크 생성에 실패했습니다.' });
        return;
      }
      res.status(200).json({ token });
    } catch (e) {
      console.error('createShare failed:', e);
      res.status(500).json({ error: '공유 링크 생성 중 오류가 발생했습니다.' });
    }
    return;
  }

  if (req.method === 'GET') {
    const token = req.query && req.query.token;
    if (!token) {
      res.status(400).json({ error: 'token이 필요합니다.' });
      return;
    }
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/result_shares?token=eq.${encodeURIComponent(token)}&select=category,sender_name,excerpt`,
        {
          headers: {
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );
      if (!r.ok) {
        res.status(500).json({ error: '조회에 실패했습니다.' });
        return;
      }
      const rows = await r.json();
      const row = rows && rows[0];
      if (!row) {
        res.status(404).json({ error: '존재하지 않는 링크입니다.' });
        return;
      }
      res.status(200).json({ category: row.category, sender_name: row.sender_name, excerpt: row.excerpt });
    } catch (e) {
      console.error('getShare failed:', e);
      res.status(500).json({ error: '조회 중 오류가 발생했습니다.' });
    }
    return;
  }

  res.status(405).json({ error: 'GET 또는 POST 요청만 지원합니다.' });
};
