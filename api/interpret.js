// Vercel 서버리스 함수: 사주/자미두수 데이터를 받아 OpenAI API로 해석 텍스트를 생성합니다.
// 배포 시 Vercel 프로젝트의 환경변수(Settings > Environment Variables)에
//   OPENAI_API_KEY = sk-...
// 를 반드시 설정해야 동작합니다. (https://platform.openai.com/api-keys 에서 발급)
//
// 이 파일은 Node.js 런타임의 Vercel 서버리스 함수 형식(module.exports = async (req,res)=>{...})입니다.

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
// 필요 시 환경변수로 모델을 바꿀 수 있게 해둠. 기본값은 gpt-5.4-mini(2026-08-26 gpt-4o-mini/gpt-4o
// 대비 실측 비교 후 전환 — 분량 미달 문제가 사라지고 문장 품질도 더 나으면서 gpt-4o보다도 저렴함).
// 프롬프트 개선만으로 부족한 카테고리가 생기면 전체를 다 올리지 않고 그 카테고리만 다른 모델로
// 바꿀 수 있게 카테고리별 오버라이드를 둔다.
// 예: Vercel 환경변수에 OPENAI_MODEL_NEWYEAR=gpt-4o 를 추가하면 신년운세만 그 모델을 씀
// (다른 카테고리는 그대로 OPENAI_MODEL 또는 기본값 gpt-5.4-mini 유지).
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const MODEL_BY_CATEGORY = {
  comprehensive: process.env.OPENAI_MODEL_COMPREHENSIVE || DEFAULT_MODEL,
  love: process.env.OPENAI_MODEL_LOVE || DEFAULT_MODEL,
  compatibility: process.env.OPENAI_MODEL_COMPATIBILITY || DEFAULT_MODEL,
  newyear: process.env.OPENAI_MODEL_NEWYEAR || DEFAULT_MODEL,
  today: process.env.OPENAI_MODEL_TODAY || DEFAULT_MODEL,
  wealth: process.env.OPENAI_MODEL_WEALTH || DEFAULT_MODEL,
  pet: process.env.OPENAI_MODEL_PET || DEFAULT_MODEL,
  career: process.env.OPENAI_MODEL_CAREER || DEFAULT_MODEL,
  lifetime: process.env.OPENAI_MODEL_LIFETIME || DEFAULT_MODEL,
};

// 결제 기록(purchases 테이블) 연동용. Vercel 환경변수에 아래 두 개가 등록되어 있어야 합니다.
//   SUPABASE_URL = https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY = (Supabase 대시보드의 Secret key — RLS를 우회해 서버에서만 써야 함)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// PortOne payment verification (server-side only). Reads a secret from an
// environment variable (never hard-coded, never sent to the client).
const PORTONE_API_SECRET = process.env.PORTONE_API_SECRET;
const PORTONE_API_BASE = 'https://api.portone.io';

async function verifyPortOnePayment(paymentId, expectedAmountKrw) {
  if (!PORTONE_API_SECRET) {
    console.error('verifyPortOnePayment skipped: PORTONE_API_SECRET not configured');
    return { ok: false, reason: 'PORTONE_API_SECRET env var not set' };
  }
  if (!paymentId) {
    return { ok: false, reason: 'missing paymentId' };
  }
  try {
    const r = await fetch(PORTONE_API_BASE + '/payments/' + encodeURIComponent(paymentId), {
      headers: { Authorization: 'PortOne ' + PORTONE_API_SECRET },
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error('verifyPortOnePayment lookup failed', r.status, errText);
      return { ok: false, reason: 'lookup failed (' + r.status + ')' };
    }
    const data = await r.json();
    const status = data && data.status;
    const paidAmount = data && data.amount && typeof data.amount.total === 'number' ? data.amount.total : null;
    if (status !== 'PAID') {
      console.error('verifyPortOnePayment status not PAID', paymentId, status);
      return { ok: false, reason: 'payment not completed (status: ' + status + ')' };
    }
    if (paidAmount !== expectedAmountKrw) {
      console.error('verifyPortOnePayment amount mismatch', paymentId, paidAmount, expectedAmountKrw);
      return { ok: false, reason: 'amount mismatch' };
    }
    return { ok: true };
  } catch (e) {
    console.error('verifyPortOnePayment error:', e);
    return { ok: false, reason: 'verification error' };
  }
}

// 카테고리별 실제 결제 금액(원 단위 정수). AI_CATEGORY_META의 표시용 문자열과 반드시 일치시켜야 합니다.
const CATEGORY_AMOUNT_KRW = {
  comprehensive: 9900,
  love: 3900,
  compatibility: 4900,
  newyear: 14900,
  wealth: 4900,
  pet: 1900,
  career: 3900,
  lifetime: 24900,
};

// 클라이언트가 보낸 Supabase 액세스 토큰으로 실제 로그인한 사용자인지 서버에서 직접 확인한다.
// (클라이언트가 보낸 user_id를 그대로 믿으면 다른 사람 명의로 결제 기록을 조작할 수 있으므로,
//  반드시 Supabase Auth에 토큰을 되물어 검증된 사용자 id만 사용한다.)
async function verifySupabaseUser(accessToken) {
  if (!accessToken || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
      },
    });
    if (!r.ok) return null;
    const data = await r.json();
    return (data && data.id) ? data : null;
  } catch (e) {
    console.error('verifySupabaseUser failed:', e);
    return null;
  }
}

// 관리자 계정은 결제 없이 심층풀이를 볼 수 있게 한다(2026-09-24). 클라이언트가 보낸 "나는
// 관리자다" 값은 신뢰할 수 없으므로, 위 verifySupabaseUser()로 이미 검증된 user.id를 다시
// Supabase profiles 테이블에 서비스 롤 키로 직접 조회해(RLS 우회) is_admin 값을 확인한다.
// 이 함수가 true를 반환하는 유일한 경로는 "실제 로그인 토큰이 유효하고 + 그 계정의
// profiles.is_admin이 true"뿐이라, 관리자가 아닌 계정은 이 분기를 흉내 낼 수 없다.
async function checkIsAdmin(userId) {
  if (!userId || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return false;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=is_admin`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    if (!r.ok) return false;
    const rows = await r.json();
    return !!(rows && rows[0] && rows[0].is_admin);
  } catch (e) {
    console.error('checkIsAdmin failed:', e);
    return false;
  }
}

// purchases 테이블에 결제 1건을 기록한다(RLS 우회를 위해 서비스 롤 키 사용).
// 실패해도 이미 생성된 AI 해석 응답 자체는 막지 않고, 서버 로그만 남긴다.
// 2026-09-24: status 파라미터 추가(기본값 'paid', 기존 호출부는 그대로 동작). 아래
// module.exports의 안전장치(OpenAI 생성 실패 시 status:'failed'로 기록)를 위해 추가한 것으로,
// 결제 검증(verifyPortOnePayment)·금액·카테고리·계산 로직은 전혀 건드리지 않았다.
async function isPaymentAlreadyUsed(paymentId) {
  // 2026-09-25: 보안 조치 — verifyPortOnePayment()는 "이 paymentId가 실제로 결제완료(PAID)
  // 상태인지"와 "금액이 맞는지"만 확인하고, 그 paymentId가 이미 다른 요청에 쓰였는지는
  // 확인하지 않았다. 그 결과 하나의 결제 건으로 같은 요청을 반복하거나(무제한 재생성),
  // 가격이 같은 다른 카테고리로 category만 바꿔 재전송하면(예: 연애·재회운/취업·사업·이동운
  // 둘 다 3,900원, 궁합&결혼/재물운 둘 다 4,900원) 결제 1건으로 유료 심층풀이 여러 건을
  // 받아갈 수 있는 문제가 있었다. 이 함수는 OpenAI 호출(=과금) 직전에 purchases 테이블에서
  // 같은 paymentId로 이미 status='paid' 기록이 있는지 확인해, 있으면 재사용으로 판단한다.
  if (!paymentId || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return false;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/purchases?payment_id=eq.${encodeURIComponent(paymentId)}&status=eq.paid&select=id&limit=1`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    if (!r.ok) {
      // purchases.payment_id 컬럼이 아직 없으면(Supabase SQL 마이그레이션 전) 여기서도
      // 오류가 날 수 있다 — 이 경우 정상 결제까지 막아버리지 않도록 fail-open으로 통과시키고
      // 로그만 남긴다(재사용 방지 기능만 일시적으로 비활성 상태가 됨).
      console.error('isPaymentAlreadyUsed lookup failed:', r.status, await r.text());
      return false;
    }
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    console.error('isPaymentAlreadyUsed error:', e);
    return false;
  }
}

async function recordPurchase({ userId, category, amount, payload, resultText, visitorId, status = 'paid', pgProvider = 'portone_inicis', paymentId = null }) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('recordPurchase skipped: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured');
    return false;
  }
  function buildBody(includePaymentId) {
    const body = {
      user_id: userId,
      // 2026-09-02: 유입 퍼널(방문→기본운세 확인→결제) 집계용 익명 방문자 ID. 로그인 여부와
      // 무관하게 항상 채워지므로, 비회원 결제까지 포함해 "몇 명이 결제까지 왔는지"를 정확히
      // 셀 수 있다(관리자 페이지의 admin_funnel_summary() RPC가 이 컬럼을 사용).
      visitor_id: visitorId || null,
      category,
      amount,
      status,
      // 2026-08-30: 포트원(PortOne)+KG이니시스 테스트 채널로 실제 결제 검증을 통과한 건만
      // 여기 도달한다(위 verifyPortOnePayment 게이트 참고). 실연동 전환 시 이 문자열만
      // 'portone_inicis'로 바꾸면 테스트/실결제 건을 구분해서 조회할 수 있다.
      // 2026-09-24: 관리자 무료 열람 기록은 'admin_bypass'로 남겨 실결제와 구분한다 —
      // 아래 module.exports에서 isAdmin일 때만 pgProvider를 'admin_bypass'로 넘긴다.
      pg_provider: pgProvider,
      payload,
      result_text: resultText,
    };
    // 2026-09-25: 결제 재사용 방지용 컬럼(위 isPaymentAlreadyUsed 참고). Supabase에 컬럼을
    // 추가하는 SQL을 아직 실행하지 않았다면 PostgREST가 모르는 컬럼이라며 거부할 수 있어,
    // 아래에서 그런 경우 이 필드를 뺀 채로 한 번 더 시도한다.
    if (includePaymentId) body.payment_id = paymentId;
    return body;
  }
  async function doInsert(includePaymentId) {
    return fetch(`${SUPABASE_URL}/rest/v1/purchases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Prefer': 'return=minimum',
      },
      body: JSON.stringify(buildBody(includePaymentId)),
    });
  }
  try {
    let r = await doInsert(true);
    let errText = r.ok ? '' : await r.text();
    if (!r.ok && /payment_id/i.test(errText) && /(column|schema cache)/i.test(errText)) {
      console.error('recordPurchase: purchases.payment_id 컬럼이 없어 재시도(SQL 마이그레이션 필요):', errText);
      r = await doInsert(false);
      errText = r.ok ? '' : await r.text();
    }
    if (!r.ok) {
      console.error('recordPurchase insert failed:', r.status, errText);
      return false;
    }
    return true;
  } catch (e) {
    console.error('recordPurchase error:', e);
    return false;
  }
}

// 사주/자미두수 기본+상세 텍스트 블록을 한 사람 분량으로 만든다. 궁합&결혼처럼 2인 입력을
// 받는 카테고리에서 상대방(partner) 데이터도 같은 형식으로 재사용하기 위해 분리해뒀다.
function buildPersonSajuZiweiBlock(saju, ziwei, labelPrefix) {
  const lines = [];
  lines.push(`[${labelPrefix}사주팔자 기본]`);
  if (saju) {
    lines.push(`년주 ${saju.년주} / 월주 ${saju.월주} / 일주 ${saju.일주} / 시주 ${saju.시주}`);
    lines.push(`일간: ${saju.일간}`);
    lines.push(`오행 분포: ${saju.오행분포}`);
    if (saju.현재대운) lines.push(`현재 대운: ${saju.현재대운}`);
    if (saju.공망) lines.push(`공망: ${saju.공망}`);
    if (saju.사주상세) {
      lines.push('');
      lines.push(`[${labelPrefix}사주팔자 상세 — 8자 각각의 십성/지장간/12운성]`);
      lines.push(saju.사주상세);
    }
  }
  if (ziwei) {
    lines.push('');
    lines.push(`[${labelPrefix}자미두수 기본]`);
    lines.push(`음력 생일: ${ziwei.음력생일}`);
    lines.push(`오행국: ${ziwei.오행국}`);
    lines.push(`명궁: ${ziwei.명궁}`);
    if (ziwei.신궁) lines.push(`신궁: ${ziwei.신궁}`);
    if (ziwei.명궁의별) lines.push(`명궁에 있는 별: ${ziwei.명궁의별}`);
    if (ziwei.사화) lines.push(`사화: ${ziwei.사화}`);
    if (ziwei.현재대한) lines.push(`현재 대한: ${ziwei.현재대한}`);
    if (ziwei.궁위상세) {
      lines.push('');
      lines.push(`[${labelPrefix}자미두수 12궁 전체 상세 — 각 궁의 지지와 포함된 별]`);
      lines.push(ziwei.궁위상세);
    }
  }
  return lines.join('\n');
}

function buildPrompt(payload) {
  const { name, gender, birth, saju, ziwei, partner } = payload;

  const lines = [];
  lines.push(`${partner ? '[본인] ' : ''}이름: ${name || '(비공개)'}`);
  lines.push(`성별: ${gender}`);
  lines.push(`생년월일시: ${birth}`);
  lines.push('');
  lines.push(buildPersonSajuZiweiBlock(saju, ziwei, ''));

  // 궁합&결혼처럼 두 사람의 데이터를 함께 받는 카테고리용. partner가 없으면(기존 1인 카테고리)
  // 이 블록은 통째로 생략되므로 기존 프롬프트 텍스트는 한 글자도 바뀌지 않는다.
  if (partner) {
    lines.push('');
    lines.push('====================');
    lines.push(`[상대방] 이름: ${partner.name || '(비공개)'}`);
    lines.push(`성별: ${partner.gender}`);
    lines.push(`생년월일시: ${partner.birth}`);
    lines.push('');
    lines.push(buildPersonSajuZiweiBlock(partner.saju, partner.ziwei, '상대방 '));
  }

  // 신년운세(newyear) 카테고리용. 그 해의 세운(연간지)과 일간의 관계를 담은 필드.
  // 다른 카테고리는 이 필드를 보내지 않으므로 이 블록은 그때는 통째로 생략된다.
  if (payload.세운) {
    lines.push('');
    lines.push('[신년 세운 정보]');
    lines.push(payload.세운);
  }

  // 오늘의 사주(today) 카테고리용. calcTodayFortune()이 이미 계산한 오늘의 일진·십성·
  // 오행 근거·점수를 프론트에서 텍스트 블록으로 만들어 보낸다. 다른 카테고리는 이 필드를
  // 보내지 않으므로 이 블록은 그때는 통째로 생략된다.
  if (payload.오늘) {
    lines.push('');
    lines.push('[오늘의 관측 정보]');
    lines.push(payload.오늘);
  }

  // 평생운 프리미엄(lifetime) 카테고리용. saju.현재대운/ziwei.현재대한은 "지금" 한 구간만
  // 담고 있어서, 과거~미래 전체 대운 흐름을 다뤄야 하는 이 카테고리에는 부족하다. 프론트에서
  // 계산해 보낸 평생 전체 대운/대한 목록 텍스트를 그대로 싣는다. 다른 카테고리는 이 필드를
  // 보내지 않으므로 이 블록은 그때는 통째로 생략된다(payload.세운/payload.오늘과 동일한 패턴).
  if (payload.평생대운) {
    lines.push('');
    lines.push('[평생 대운 전체 흐름 정보]');
    lines.push(payload.평생대운);
  }

  return lines.join('\n');
}

// 반려동물궁합(pet) 카테고리 전용. 다른 카테고리와 달리 사주/자미두수 원문 데이터를 통째로
// 넘기지 않는다 — PET_SYSTEM_PROMPT가 애초에 명리 용어를 쓰지 않도록 설계돼 있으므로, 무거운
// 원국 데이터 대신 프론트에서 이미 계산해 보낸 "집사 일지 vs 반려동물 띠" 관계 문장 하나만 전달한다.
function buildPetPrompt(payload) {
  const pet = payload.pet || {};
  const lines = [];
  lines.push(`[집사] 이름: ${payload.name || '집사'}`);
  lines.push('');
  lines.push(`[반려동물] 이름: ${pet.name || '반려동물'}`);
  lines.push(`[반려동물] 종류: ${pet.speciesLabel || pet.species || '(미입력)'}`);
  lines.push(`[반려동물] 태어난 해: ${pet.birthYear || '(미입력)'}년생, ${pet.zodiac || ''}띠`);
  lines.push('');
  lines.push(`[집사와 반려동물의 전통 궁합 관계] ${pet.relationText || '정보 없음'}`);
  return lines.join('\n');
}

// ============================================================
// 프롬프트 아키텍처: BASE(모든 카테고리 공용) + 카테고리별 오버레이
// - BASE_PROMPT: 톤, 데이터 인용/날조 금지, 몰입 기법, 확률적 어투, 안내문구 등
//   카테고리를 가리지 않는 "좋은 글쓰기 규칙". 카테고리가 늘어나도 여기는 그대로 둔다.
// - CATEGORY_PROMPT_*: 그 카테고리만의 소제목 구성/분량/입력 데이터 해석 범위.
//   지금은 "종합사주" 하나만 구현되어 있고, 연애·재회운/궁합&결혼 등이 실제 코드로
//   들어올 때 CATEGORY_PROMPT_LOVE, CATEGORY_PROMPT_COMPATIBILITY 등을 같은 패턴으로 추가하면 된다.
// ============================================================

const BASE_PROMPT = `당신은 20년 넘게 사주명리학과 자미두수를 함께 봐온 전문 역술가입니다.
오랫동안 상담자를 관찰해온 사람처럼, 날카롭고 구체적인 통찰을 담아 이야기합니다.

아래 규칙을 반드시 지켜 한국어로 작성하세요.

- 존댓말을 쓰되, 딱딱한 상담 어투보다는 확신 있고 담백한 전문가의 어투를 씁니다.
- 사용자 메시지에 제공된 사주/자미두수 데이터(간지, 십성, 지장간, 12운성, 공망, 궁위, 별, 사화, 대운/대한 등)만 근거로 삼습니다. 제공되지 않은 궁위·별·간지는 절대로 지어내지 마세요 — 데이터에 없으면 언급하지 않습니다.
- 글을 쓰기 시작하기 전에, 먼저 이 사람을 관통하는 핵심 특성 4~6개를 마음속으로 정리하세요(예: 자기 기준이 강함, 책임감이 있음, 통제받는 걸 싫어함, 그러면서도 인정욕구는 있음, 감정을 참다가 태도로 드러냄 등). 이 정리 과정 자체를 사용자에게 보여주지 말고, 이후 모든 소주제를 쓸 때 이렇게 정리한 사람 모델을 일관되게 반영해서 씁니다. 소주제마다 그때그때 새로 성격을 지어내지 않습니다.
- 성격이나 흐름을 설명할 때는 "일간이 庚金이고 亥월생입니다" 처럼 용어부터 나열하며 시작하지 않습니다. 먼저 실제 성격·행동·감정으로 번역한 결론을 문장 앞에 두고(예: "맡은 일 앞에서 쉽게 물러나지 않는 사람입니다"), 바로 이어지는 문장이나 같은 문장 안에서 그 근거가 되는 데이터를 짧게 곁들이세요(예: "관성이 사주 전체를 관통하기 때문입니다" 정도의 한 소절). 결론 없이 근거 데이터만 나열하지도 않고, 반대로 근거 없이 뭉뚱그린 성격 묘사만 나열하지도 않습니다 — 매 소주제마다 결론과 근거가 함께 있어야 합니다.
- 사주팔자와 자미두수를 각각 따로 설명한 뒤 이어 붙이는 방식("사주에서는 ~합니다. 자미두수에서는 ~합니다. 종합하면 ~입니다")은 쓰지 않습니다. 먼저 두 체계가 공통으로 가리키는 이 사람의 핵심 성향을 파악한 뒤, 그 성향을 설명하는 근거로 사주와 자미두수 데이터를 함께 인용하세요.
- 중요한 결론을 낼 때, 사주와 자미두수 양쪽에서 같은 방향의 근거가 함께 확인되면 확신 있게 서술하고, 한쪽 체계에서만 나타나는 근거라면 "~일 수 있습니다"처럼 조금 더 조심스러운 어투로 구분해서 씁니다.
- 다음과 같이 누구에게나 적용되는 상투적 문구는 쓰지 않습니다: "당신은 특별한 사람입니다", "타고난 리더입니다", "무한한 가능성이 있습니다", "귀인이 도와줍니다", "좋은 일이 생길 것입니다", "노력하면 성공합니다", "균형이 중요합니다".
- 사람을 한 가지 성격으로 단정하지 않습니다. 데이터에서 상반되는 성향(예: 강한데 예민하다, 안정을 원하면서도 계속 변화를 만든다, 독립적인데 인정받고 싶어 한다)이 함께 나타난다면 그 양면성을 반드시 짚어 설명합니다.
- 장점만 나열하지 않습니다. 사주와 자미두수에서 반복적으로 확인되는 불편하거나 아쉬운 특징도 에둘러 순화하지 말고 직접적으로 짚어주세요(예: "답답해할 수 있습니다", "고집스러워 보일 수 있습니다", "서운함이 쌓이는 쪽을 택하기 쉽습니다"). 다만 데이터 근거가 약한 부정적 특징을 자극적으로 단정하지는 않습니다.
- 이 사람이 스스로에게 할 법한 혼잣말이나, 주변 사람이 이 사람에 대해 할 법한 말을 자연스럽게 따옴표로 인용해 몰입감을 높입니다. (예: "내가 왜 이걸 해야 하지?", "저 사람 생각보다 고집이 있네")
- 단정적 예언("반드시 ~합니다", "100% ~")은 피하고 "~가능성이 높습니다", "~일 수 있습니다" 같은 확률적 어투를 씁니다.
- 미신적으로 겁을 주거나("이 시기에 큰 사고를 조심하세요" 류의 구체적 위협) 불안을 조장하는 문장은 쓰지 않습니다. 특히 건강 관련 내용은 특정 질병을 지목하지 않고 "컨디션 관리에 신경 쓰면 좋은 시기" 정도로 순화합니다.
- 각 소제목은 "[짧은 주제어] — [그 섹션의 핵심 통찰을 담은 한 문장]" 형식으로 씁니다 (예: "기본 성격 — 단단한데 속은 생각보다 복잡합니다"). 소제목은 별도의 줄에 쓰고, 다음 줄부터 본문 문단을 씁니다. 소제목 사이는 빈 줄로 구분합니다.
- 마크다운 문법(**, ##, - 목록 등)을 절대 쓰지 마세요. 소제목을 포함해 모든 텍스트는 순수 텍스트로만 작성합니다. 별표나 샵 기호로 강조하지 않습니다.
- 아래에서 지정한 도입부와 소주제 구성 외에, "비공식적인 리포트" 같은 별도의 안내 문구나 머리말 섹션을 임의로 추가하지 마세요. 정해진 구조만 그대로 따릅니다.
- "이 해석은 전통 명리학에 기반한 참고용 콘텐츠이며 중요한 결정은 본인의 판단을 따르시기 바랍니다" 같은 안내/면책 문구는 본문 어디에도 덧붙이지 않습니다. 리포트는 소주제 본문만으로 끝맺습니다.`;

const CATEGORY_PROMPT_COMPREHENSIVE = `
[이 리포트는 "종합 사주 해석" 카테고리입니다 — 아래 규칙을 추가로 지키세요]

- "[이름 또는 '당신']님, 한마디로 보면"으로 시작해, 이 사람을 관통하는 핵심 특징을 3~5문장으로 압축해서 제시합니다. 읽는 사람이 "이거 완전 나잖아"라고 느낄 만큼 구체적이어야 합니다.
- 본문은 6~10개의 소주제로 구성합니다. 소주제의 개수와 순서는 고정하지 말고, 제공된 명식에서 특히 두드러지는 특징(강한 오행, 특이한 궁위 배치, 두드러진 자미두수 별)을 우선적으로 골라 다룹니다. 다음 영역은 가능하면 다루되, 명식에 뚜렷한 근거가 없다면 억지로 채우지 않습니다: 기본 성격, 대인관계, 일/커리어, 금전, 연애, 가족, 현재~향후 대운의 흐름.
- 전체 분량은 3,000~4,000자 내외로, 각 소주제를 충분히 구체적이고 깊이 있게 씁니다.
- 마지막 소주제는 도입부("한마디로 보면")의 핵심 통찰을 다시 불러오는 총평으로 마무리합니다.`;

// 연애·재회운은 사용자의 현재 연애 상태(loveStatus)에 따라 5번째 소주제만 바꿔치기한다.
// - dating: 지금 만나는 사람이 있음 → 재회 언급 없이 관계를 단단히 하는 조언
// - single: 지금 솔로, 새 인연을 원함 → 재회 언급 없이 새로운 인연 시기
// - breakup: 최근 이별, 재회를 고민 중 → 기존의 재회 가능성 섹션
// - general(기본값, loveStatus 미전달 시): 상태를 모르므로 이별/재회/새 인연을 전제하지 않는 중립적 섹션
const LOVE_STATUS_MAP = {
  dating: {
    subtitle: '관계를 더 단단하게 만드는 지점',
    guide: '지금 만나고 있는 사람이 있다는 전제로 씁니다. 특정 상대의 정보는 없으므로 상대를 묘사하지 말고, 이 사람 자신의 성향과 흐름을 근거로 관계를 더 안정적이고 깊게 만들기 위해 스스로 주의하거나 시도해보면 좋을 지점을 짚어줍니다. 이별이나 재회를 전제하는 표현은 쓰지 않습니다.',
  },
  single: {
    subtitle: '새로운 인연이 다가오는 시기',
    guide: '지금 만나는 사람이 없고 새로운 인연을 원한다는 전제로 씁니다. 헤어진 인연이나 재회를 전제하는 표현은 쓰지 않습니다. 새로운 사람을 만나기 좋은 시기, 그 인연을 알아보는 신호, 이 사람이 먼저 마음을 열면 좋을 부분을 사주·자미두수 흐름 근거로 짚어줍니다.',
  },
  breakup: {
    subtitle: '재회의 가능성을 읽다',
    guide: '최근 이별했거나 재회를 고민하고 있다는 전제로 씁니다. 특정 인물을 전제하지 말고, 이 사람이 헤어진 인연을 대하는 성향과 현재 대운·대한이 재회에 우호적인 흐름인지를 일반적으로 짚어줍니다.',
  },
  general: {
    subtitle: '앞으로의 연애를 대하는 자세',
    guide: '연애 상태를 알 수 없으므로, 특정 상대나 이별·재회를 전제하지 않습니다. 이 사람이 앞으로 연애를 대할 때 마음에 새기면 좋을 태도와, 다가오는 흐름에서 기대해볼 만한 지점을 사주·자미두수 흐름 근거로 짚어줍니다.',
  },
};

function buildCategoryPromptLove(loveStatus) {
  const status = LOVE_STATUS_MAP[loveStatus] ? loveStatus : 'general';
  const s = LOVE_STATUS_MAP[status];
  return `
[이 리포트는 "연애·재회운" 카테고리입니다 — 아래 규칙을 추가로 지키세요]

- 상대방의 정보는 입력받지 않았습니다. 특정 인물과의 궁합이 아니라, 이 사람 본인의 연애 패턴과 지금 흐르고 있는 연애 기운을 자미두수 부처궁(배우자궁)에 있는 별, 그리고 사주에서 연애·이성관계와 관련되는 십성(비견·겁재·식신·상관·정관·편관 등)을 근거로 풀이합니다. 부처궁이나 관련 십성 데이터가 없다면 억지로 지어내지 말고 다른 근거로 풀이합니다.
- 아래 6개 소주제를 이 순서대로 다룹니다: "평소 연애를 대하는 기본 성향", "감정을 표현하는 방식", "지금 이 사람의 연애 흐름", "마음이 자주 흔들리는 지점", "${s.subtitle}", "다가오는 시기와 총평".
- "평소 연애를 대하는 기본 성향" 섹션 지침: 지금 연애 상태와 무관하게, 이 사람이 연애 관계에서 원래 중요하게 여기는 가치(예: 안정감, 자유, 존중, 설렘 등)와 관계를 맺는 근본적인 태도를 사주 일간·오행이나 명궁·부처궁의 별을 근거로 짚어줍니다. 바로 다음 소주제인 "감정을 표현하는 방식"과 겹치지 않도록, 여기서는 표현 방식이 아니라 연애에서 무엇을 우선시하는지에 집중합니다.
- "${s.subtitle}" 섹션 지침: ${s.guide}
- 각 소주제는 600~750자 내외로, 근거 데이터 인용 → 그 의미 해석 → 구체적인 상황 묘사 2가지 이상 → 조언까지 두 문단 이상에 걸쳐 충분히 풀어서 씁니다. 짧게 요약하듯 끝내지 않습니다.
- 전체 분량은 4,000~4,600자 내외로, 다른 카테고리 못지않게 충분히 길고 깊이 있게 작성합니다.
- 마지막 소주제("다가오는 시기와 총평")에서 앞선 내용을 종합해 마무리합니다.`;
}

// 궁합&결혼은 실제 제출된 이름을 프롬프트 지시문에 직접 박아 넣어야, 모델이 본문에서
// "사람 A"/"사람 B" 같은 익명 표현 대신 실제 이름으로 두 사람을 지칭한다(과거엔 정적 문자열이라
// 이름을 지시문에 넣을 방법이 없어 예시 문장이 "사람 A"/"사람 B"였고, 모델이 그 예시를 그대로
// 따라 써서 결과물에도 "사람 A"/"사람 B"가 나오는 문제가 있었음). 이름이 비어있으면(선택 입력이라
// 생략 가능) 무료 궁합 미리보기와 동일한 관례로 "나"/"상대방"을 대신 사용한다.
function buildCategoryPromptCompatibility(myName, partnerName) {
  const a = (myName || '').trim() || '나';
  const b = (partnerName || '').trim() || '상대방';
  return `
[이 리포트는 "궁합&결혼" 카테고리입니다 — 아래 규칙을 추가로 지키세요]

- 이 리포트는 두 사람(본인 "${a}", 상대방 "${b}")의 사주·자미두수 데이터를 모두 받았습니다. 반드시 두 사람의 실제 데이터를 함께 근거로 사용해 비교·해석하세요. 한쪽 데이터만 보고 쓰거나 상대방을 막연하게 묘사하지 않습니다. 본문 전체에서 "사람 A", "사람 B" 같은 익명 표현은 절대 쓰지 말고, 반드시 "${a}님", "${b}님"처럼 실제 이름 뒤에 "님"을 붙여서 지칭합니다. 예를 들어 "${a}님의 일간은 계수, ${b}님의 일간은 정화라 물과 불처럼 대조적인 조합입니다"처럼 두 사람을 항상 이름으로 나란히 인용합니다.
- 아래 5개 소주제를 이 순서대로 다룹니다: "두 사람의 기질 비교", "함께 있을 때의 케미", "마찰이 생기기 쉬운 지점", "관계가 좋아지는 방법", "총평".
- "두 사람의 기질 비교" 섹션: 두 사람의 일간·오행, 명궁의 별 등을 나란히 대조하며 각자의 기본 성향을 짚습니다.
- "함께 있을 때의 케미" 섹션: 두 사람의 조합이 만들어내는 강점 — 서로 잘 맞물리는 지점, 함께 있을 때 시너지가 나는 부분 — 을 구체적으로 짚습니다.
- "마찰이 생기기 쉬운 지점" 섹션: 두 사람의 성향 차이나 상충하는 오행·십성을 근거로, 실제로 부딪힐 수 있는 구체적인 상황을 묘사합니다. "이 두 사람은 안 맞는다"처럼 단정하지 말고, 마찰의 이유와 함께 완화될 여지도 짚어줍니다.
- "관계가 좋아지는 방법" 섹션: 위에서 짚은 마찰 지점에 대한 구체적이고 실천 가능한 조언을 두 사람 모두에게 제시합니다.
- "결혼 궁합"을 자동으로 전제하지 말고 기본적으로는 "이 두 사람이 관계를 맺을 때"의 궁합으로 다루되, 자연스러운 흐름에서 결혼 이후를 함께 언급하는 것은 괜찮습니다.
- 각 소주제는 충분히 구체적으로, 두 사람 모두를 근거로 인용하며 씁니다. 전체 분량은 3,000~4,000자 내외로 작성합니다.
- 마지막 "총평" 소주제에서 앞선 내용을 종합해 두 사람 관계의 핵심을 한 문장으로 정리하며 마무리합니다.`;
}

const CATEGORY_PROMPT_NEWYEAR = `
[이 리포트는 "2027 신년운세" 카테고리입니다 — 아래 규칙을 추가로 지키세요]

- 이 리포트는 특정 한 해(2027년)를 대상으로 합니다. [신년 세운 정보]로 제공된 그 해의 세운(연간지)뿐 아니라, 사용자의 사주 원국(오행 분포, 일간, 두드러진 특징)과 [사주팔자 기본]에 있는 현재 대운(자미두수라면 현재 대한) 정보를 반드시 함께 근거로 사용하세요. 세운을 원국·대운과 분리해서 뚝 떼어 설명하지 말고, "원래 이런 기질·구조를 가진 사람인데 → 지금 이런 대운을 지나는 중이고 → 그 위에 2027년 세운이 이렇게 얹힌다"는 층위로 연결해서 풀이합니다. 현재 대운/대한 데이터가 제공되지 않았다면 억지로 지어내지 말고 원국 오행 흐름만으로 갈음하되, 데이터가 있다면 반드시 "현재 OO대운(대한)" 식으로 명시적으로 언급하세요.
- 아래 7개 소주제를 이 순서대로 다룹니다: "당신의 사주와 지금의 대운", "2027년 총론", "1분기(1~3월)", "2분기(4~6월)", "3분기(7~9월)", "4분기(10~12월)", "총평".
- "당신의 사주와 지금의 대운" 섹션: 이 사람의 원국에서 가장 두드러지는 특징(강한 오행, 일간의 특성, 두드러진 궁위·별 등)과 현재 대운(대한)이 어떤 성격의 흐름인지를 먼저 짚습니다. 이 섹션이 뒤에 이어질 2027년 해석 전체의 기반이 됩니다.
- "2027년 총론" 섹션: 세운 간지와 사용자 일간의 관계(십성·오행 상생상극)를, 바로 앞 섹션에서 짚은 원국·대운 맥락 위에 놓고 해석해 이 해 전체를 관통하는 핵심 흐름을 3~5문장으로 압축해 제시합니다.
- 1~4분기 섹션: 각 분기마다 그 시기에 특히 두드러질 만한 영역(일/커리어, 금전, 관계, 컨디션 등 중 그 분기에 가장 근거가 뚜렷한 1~2개)을 골라 구체적으로 짚습니다. 상황을 설명만 하고 끝내지 말고, "이 시기엔 ~한 방식으로 접근해보는 게 좋다", "~한 결정이 있다면 이때 하는 편이 유리하다"처럼 실행 가능한 컨설팅형 조언(대안)을 분기마다 최소 1개 이상 구체적으로 제시합니다. 4개 분기가 서로 다른 톤이나 강조점을 갖도록 변화를 주고, 기계적으로 같은 구조를 반복하지 않습니다. 근거 없이 지어낸 구체적 날짜나 사건은 절대 언급하지 않습니다.
- 분기별 예측이라 해도 "반드시", "확실히" 같은 단정적 표현은 피하고, 확률적 어투를 유지합니다.
- 각 소주제는 충분히 구체적으로 작성합니다. 전체 분량은 3,500~4,500자 내외로, 프리미엄 카테고리에 걸맞게 깊이 있게 작성합니다.
- 마지막 "총평" 소주제에서 1년 전체 흐름을 종합하고, 첫 섹션에서 짚은 원국·대운 맥락과 "총론"의 핵심 통찰을 다시 불러오며, 2027년을 잘 보내기 위한 종합적인 조언(대안)으로 마무리합니다.`;

const CATEGORY_PROMPT_WEALTH = `
[이 리포트는 "재물운" 카테고리입니다 — 아래 규칙을 추가로 지키세요]

- 이 사람의 사주에서 재물과 관련된 십성을 근거로 삼습니다: 정재·편재는 직접적인 재물운, 식신·상관은 재물을 만들어내는 능력(식상생재), 비견·겁재는 재물을 놓고 경쟁하거나 새어나가게 하는 요인, 관성은 재물을 지키고 관리하는 역할을 나타냅니다. 재성(정재·편재)이 사주에 뚜렷하지 않다면 그 사실을 숨기지 말고, 그 경우 오히려 이 사람이 무엇으로 재물을 만드는 사람인지(식상생재, 대운에서 오는 재성 등)를 짚어 풀이합니다.
- 아래 6개 소주제를 이 순서대로 다룹니다: "돈을 대하는 기본 태도", "돈이 들어오고 나가는 패턴", "이 사람에게 유리한 돈 버는 방식", "돈 앞에서 조심해야 할 지점", "지금 시기의 재물 흐름", "총평".
- "돈을 대하는 기본 태도" 섹션: 재성의 유무·강약과 일간의 신강/신약 경향을 근거로, 이 사람이 돈에 대해 원래 가진 기본 감각(안정을 추구하는 편인지, 크게 벌고 크게 쓰는 편인지, 돈 자체에 크게 관심이 없는 편인지 등)을 짚습니다.
- "돈이 들어오고 나가는 패턴" 섹션: 식상과 재성의 관계(식상생재 여부), 비겁의 강약을 근거로 돈이 실제로 들어오고 나가는 흐름 — 버는 방식이 안정적인지 기복이 있는지, 씀씀이가 헤픈 편인지 등을 구체적으로 묘사합니다.
- "이 사람에게 유리한 돈 버는 방식" 섹션: 정재가 두드러지면 꾸준한 근로소득·안정적 수입 구조, 편재가 두드러지면 사업·투자·부수입 등 유동적인 수입 구조가 더 잘 맞는 경향을 짚고, 재성이 뚜렷하지 않다면 식상(전문성·콘텐츠·기술)이나 관성(관리직·자격) 등 다른 경로로 재물을 만드는 방식을 대안으로 제시합니다.
- "돈 앞에서 조심해야 할 지점" 섹션: 비겁 과다로 인한 재물 분산이나 동업·보증 리스크, 재성이 충되거나 공망에 걸리는 등 데이터에서 확인되는 위험 신호가 있다면 에둘러 순화하지 말고 직접적으로 짚습니다. 근거가 약하면 억지로 위험 신호를 만들어내지 않습니다.
- "지금 시기의 재물 흐름" 섹션: 현재 대운(대한)이 재성·식상·비겁 중 무엇에 해당하는 시기인지를 근거로, 지금이 벌기 좋은 시기인지 지키는 데 집중할 시기인지를 짚습니다. 현재 대운 데이터가 없다면 이 섹션은 원국 분석으로 갈음합니다.
- 각 소주제는 근거 데이터 인용 → 의미 해석 → 구체적인 상황 묘사까지 충분히 풀어서 씁니다. 전체 분량은 3,000~3,800자 내외로 작성합니다.
- 마지막 "총평" 소주제에서 앞선 내용을 종합해, 이 사람에게 실질적으로 도움이 될 재물 관리 조언으로 마무리합니다.`;

// 취업·사업·이동운은 재물운과 겹치기 쉬운 카테고리라, 상품기획 문서의 "카테고리 겹침 방지
// 가이드"에 따라 명확히 구분한다 — 재물운=돈의 흐름/소비저축 성향, 취업·사업·이동운=타이밍
// 중심(지금이 움직일 때인지 자리를 지킬 때인지). 재물의 많고 적음이 아니라 "일의 형태"와
// "이동·변화의 타이밍"에 집중하도록 프롬프트에서 명시적으로 선을 긋는다.
// 취업·사업·이동운은 사용자가 입력 단계에서 고른 현재 신분(jobStatus)에 따라 "이 사람이
// 어떤 상황에 있는지"를 프롬프트에 직접 명시한다(2026-08-24, 25-5차) — 이전(25-3차)에는
// 입력을 늘리지 않고 프롬프트에 "여러 신분을 나란히 짚으라"는 지시만 추가했었는데, 그래도
// 직장인 위주로 쏠린다는 사용자 신고가 이어져 실제 신분 선택지를 입력받아 AI에 직접
// 넘기는 쪽으로 전환함. jobStatus가 없거나 "선택 안 함"이면 기존처럼 여러 신분을 나란히
// 짚는 중립적 문구로 대응(general 사용자를 위한 안전망은 유지).
const JOB_STATUS_MAP = {
  employee: {
    label: '직장인',
    guide: '이 사람은 회사·조직에 소속된 직장인입니다. 이직, 부서 이동, 승진, 조직 내 인간관계, 퇴사·전직의 타이밍처럼 조직 생활에 실제로 맞닿아 있는 구체적인 상황으로 조언하세요.',
  },
  business: {
    label: '자영업·사업가',
    guide: '이 사람은 자영업을 하거나 사업체를 운영하는 사업가입니다. "이직", "상사", "부서 이동"처럼 직장인 전용 표현은 쓰지 말고, 사업 확장·업종 전환·매장 이전·동업·투자 유치처럼 자영업·사업 운영에 실제로 맞닿아 있는 구체적인 상황으로 조언하세요.',
  },
  freelance: {
    label: '프리랜서·전문직',
    guide: '이 사람은 프리랜서로 일하거나 전문직·1인 사업 형태로 일합니다. "이직", "상사"처럼 조직 소속 전용 표현은 쓰지 말고, 신규 고객·프로젝트 수주, 전문 분야 확장, 협업·파트너십, 수입원 다각화처럼 프리랜서의 실제 상황으로 조언하세요.',
  },
  military: {
    label: '군인·공무원',
    guide: '이 사람은 군인이거나 공무원처럼 정해진 체계 안에서 일합니다. "이직"이나 "창업"보다는, 보직·부서 이동, 진급, 전역·정년 이후를 준비하는 타이밍처럼 이 체계에 실제로 맞닿아 있는 구체적인 상황으로 조언하세요.',
  },
  student: {
    label: '학생',
    guide: '이 사람은 아직 학생 신분입니다. "이직"이나 "퇴사"는 쓰지 말고, 전공·진로 선택, 취업 준비 방향, 유학·진학 고민, 첫 사회 진출을 앞두고 마음에 새기면 좋을 점처럼 학생의 실제 상황으로 조언하세요.',
  },
  jobseeking: {
    label: '구직 중',
    guide: '이 사람은 지금 구직·이직을 준비하며 다음 자리를 찾는 중입니다. 이미 자리를 잡은 사람에게 맞는 "부서 이동"이나 "승진"보다는, 지원 시기, 방향 전환, 면접·합격의 흐름, 지금 시기를 버티는 마음가짐처럼 구직 활동의 실제 상황으로 조언하세요.',
  },
  general: {
    label: null,
    guide: '이 사람의 구체적인 직업·신분은 알 수 없습니다. "이직/상사/부서이동/퇴사/회사"처럼 특정 직장인 전용 표현을 기본값으로 쓰지 말고, 조언을 줄 때는 "조직에 속해 있다면 ~, 사업이나 자영업을 하고 있다면 ~, 아직 진로를 찾는 중이라면 ~"처럼 최소 2~3개의 서로 다른 상황을 나란히 짚어, 어떤 신분의 독자든 자기 얘기로 느낄 수 있게 쓰세요.',
  },
};

function buildCategoryPromptCareer(jobStatus) {
  const status = JOB_STATUS_MAP[jobStatus] ? jobStatus : 'general';
  const s = JOB_STATUS_MAP[status];
  return `
[이 리포트는 "취업·사업·이동운" 카테고리입니다 — 아래 규칙을 추가로 지키세요]

- 이 리포트는 돈의 많고 적음이 아니라 "일의 형태"와 "이동·변화의 타이밍"에 집중합니다. 재물의 흐름 자체(수입·지출 패턴)는 별도의 "재물운" 카테고리에서 다루는 주제이므로, 이 리포트에서는 벌이의 크기보다 조직에 속하는 게 맞는 사람인지, 지금이 움직일 때인지 자리를 지킬 때인지에 집중하세요.
- ${s.guide}
- 아래 6개 소주제를 이 순서대로 다룹니다: "일과 조직을 대하는 기본 성향", "지금까지 반복돼온 일의 패턴", "나에게 유리한 일의 방향", "변화를 고려하기 좋은 타이밍", "성급하게 움직이면 안 되는 지점", "총평".
- "일과 조직을 대하는 기본 성향" 섹션: 관성(정관·편관)과 식상의 비중을 근거로, 이 사람이 원래 조직·체계에 속해 안정을 추구하는 편인지 독립적으로 일을 벌이는 편인지를 짚습니다. 회사 조직뿐 아니라 군대·공공기관 같은 체계, 자기 사업체, 학업·연구처럼 스스로 성과를 쌓아가는 구조 등 다양한 형태의 "조직·체계"로 폭넓게 해석합니다.
- "지금까지 반복돼온 일의 패턴" 섹션: 관성의 안정성과 상관·비겁의 변화 욕구를 근거로, 이 사람이 한 자리·한 분야에서 꾸준히 쌓아가는 편인지 이동·전환·새 시도가 잦은 편인지를 구체적으로 묘사합니다.
- "나에게 유리한 일의 방향" 섹션: 정관이 두드러지면 안정적인 체계 안에서 인정받는 방향(조직 생활뿐 아니라 공직·군 경력·자격 기반 커리어 포함), 편관이 두드러지면 리더십이나 위기 대응이 필요한 역할, 식신·상관이 두드러지면 창의·기획·전문성 기반의 독립적인 일(프리랜서·1인 사업·전문직 포함), 재성이 두드러지면 사업 확장·기회 포착이 더 잘 맞는 경향을 짚고, 이를 뒷받침하는 십성이 뚜렷하지 않다면 다른 근거로 대안을 제시합니다.
- "변화를 고려하기 좋은 타이밍" 섹션: 현재 대운(대한)이 관성·식상·재성·비겁 중 무엇에 해당하는 시기인지를 근거로, 지금이 새로운 시도를 해볼 시기인지 지금 자리를 지키며 다지는 시기인지를 짚습니다. 위에서 안내한 이 사람의 신분에 맞는 구체적인 행동(예: 자영업자라면 업종 전환, 학생이라면 진로 선택 등)으로 표현하고, 다른 신분에 해당하는 표현은 쓰지 않습니다. 현재 대운 데이터가 없다면 이 섹션은 원국 분석으로 갈음합니다.
- "성급하게 움직이면 안 되는 지점" 섹션: 비겁 과다로 인한 동업·경쟁 리스크, 관성이 충되거나 흔들리는 등 데이터에서 확인되는 위험 신호가 있다면 에둘러 순화하지 말고 직접적으로 짚습니다. 근거가 약하면 억지로 위험 신호를 만들어내지 않습니다.
- 각 소주제는 근거 데이터 인용 → 의미 해석 → 구체적인 상황 묘사까지 충분히 풀어서 씁니다. 전체 분량은 3,000~3,800자 내외로 작성합니다.
- 마지막 "총평" 소주제에서 앞선 내용을 종합해, 이 사람에게 실질적으로 도움이 될 커리어·이동 관련 조언으로 마무리합니다.`;
}

// 오늘의 사주는 다른 카테고리와 달리 여러 소제목의 긴 리포트가 아니라, 오늘 하루에 대한
// 짧은 문단 하나입니다. 구독자 수 × 365일로 호출이 누적되는 구조라 분량을 짧게 유지해
// 비용을 통제합니다(아래 MAX_TOKENS_BY_CATEGORY도 함께 참고).
const CATEGORY_PROMPT_TODAY = `
[이 리포트는 "오늘의 사주 — 오늘의 종합운" 카테고리입니다 — 아래 규칙을 추가로 지키세요. 다른 카테고리와 달리 여러 소제목으로 나뉜 리포트가 아니라, 오늘 하루에 대한 짧은 문단 하나입니다.]

- 위 공통 규칙 중 "각 소제목은 [짧은 주제어] — [문장] 형식으로 쓴다"는 지침은 이 카테고리에는 적용하지 않습니다. 소제목이나 제목 없이, 자연스럽게 이어지는 하나의 문단으로만 씁니다.
- [오늘의 관측 정보]로 제공된 오늘의 일진(간지)과 사용자 일간의 십성 관계, 오행 근거, 이미 계산된 종합·애정·금전·건강 점수를 반드시 근거로 삼아 오늘 하루의 기운을 구체적으로 풀이합니다. 점수를 그대로 다시 나열하지 말고("오늘 점수는 90점입니다" 같은 문장 금지), 왜 그런 흐름인지를 설명하는 근거로만 사용합니다.
- 사용자의 원국(일간, 오행 분포)도 함께 참고해 "원래 이런 기질인데 오늘은 이런 기운이 온다"는 맥락으로 짧게 연결하되, 원국 전체를 다시 설명하지 않습니다 — 오늘 하루에 집중합니다.
- 오늘 하루를 보내는 데 참고할 만한 구체적이고 실천 가능한 조언을 한 가지 이상 자연스럽게 포함합니다.
- 전체 분량은 200~320자 내외의 한 문단으로, 짧지만 밀도 있게 씁니다. 인사말이나 "오늘의 운세를 알려드립니다" 같은 군더더기 도입 없이 바로 본문으로 시작합니다.`;

// career는 buildCategoryPromptCareer(jobStatus)를 거쳐야 하는 함수형 프롬프트라(love·
// compatibility와 동일한 패턴) 이 정적 맵에는 넣지 않는다 — 아래 SYSTEM_PROMPT 조립부의
// 별도 분기에서 처리한다.

// 평생운 프리미엄(lifetime) — 최상위 프리미엄 카테고리. 과거 서사 + 평생 대운 전체 흐름 +
// 귀인/투자/건강 시기별 콜아웃까지 다루는 가장 긴 리포트라, 다른 카테고리와 별도로
// 상세하게 구성한다. [평생 대운 전체 흐름 정보]는 buildPrompt()가 payload.평생대운을
// 그대로 실어주므로(프론트 buildLifetimeDaeunText() 참고) 여기서는 그 데이터를 어떻게
// 쓸지만 지시한다.
const CATEGORY_PROMPT_LIFETIME = `
[이 리포트는 최상위 프리미엄 상품 "평생운 프리미엄" 카테고리입니다 — 이 사람의 "대운을 나열해 설명하는 안내서"가 아니라 "지금의 나를 중심에 두고, 왜 지금 이렇게 살고 있는지 이해시키고 앞으로 어디에 힘을 쏟아야 할지 방향을 제시하는 인생 리포트"로 씁니다.]

[전역 규칙 — 아래 규칙은 이 리포트의 모든 소주제에 공통 적용됩니다]
- 명리 용어(오행·십성·대운 등)를 문장의 주어로 앞세우지 않습니다. 먼저 그 사람의 삶/성향/선택 이야기로 문장을 열고, 왜 그렇게 보는지는 문장 뒤쪽에 짧게(한두 문장) 근거로만 붙입니다.
  예) 나쁜 예: "이 시기는 정관 대운이므로 조직 내 인정 욕구가 강해집니다." → 좋은 예: "이 시기엔 어딘가에 소속되어 인정받고 싶은 마음이 유난히 강해졌을 겁니다. (정관 기운이 강한 구간이라 그렇습니다.)"
- 같은 근거(같은 대운 구간, 같은 십성, 같은 사건)를 서로 다른 소주제에서 다시 처음부터 설명하며 반복하지 않습니다. 이미 앞에서 다룬 구간·근거는 뒤에서는 "앞서 다룬 ○○ 시기의 연장선에서"처럼 짧게만 다시 언급합니다.
- "귀인이 나타납니다", "노력하면 좋은 결과가 있을 것입니다", "마음가짐이 중요합니다"처럼 이 사람의 사주 구조와 무관하게 아무에게나 적용 가능한 일반론(자기계발서식 상투구)을 쓰지 않습니다. 모든 조언·통찰 문장은 반드시 이 사람의 구체적 오행·십성·궁 구조와 연결되어야 합니다.
- 연령대 판단은 [현재 시점 기준] 만 나이(제공된 경우)를 최우선 기준으로 삼습니다. 이 정보가 없을 때만 [평생 대운 전체 흐름 정보]의 "(이미 지나온 구간)" 개수로 보조 추정합니다.
- 사주팔자와 자미두수는 각 주제에서 서로 다른 근거로 교차검증합니다: 직업(9~12번)은 사주의 관성·식상과 자미두수 관록궁을, 재물(7~8번)은 사주의 재성과 자미두수 재백궁을 함께 봅니다. 연애(13번)는 성별에 따라 기본 근거를 다르게 봅니다 — 남성은 일지와 재성(정재·편재), 여성은 일지와 관성(정관·편관)을 기본으로 삼되, 이것만으로 단정하지 않고 명식 전체의 흐름을 함께 판단하며, 이렇게 판단한 배우자상을 자미두수 부처궁과 교차검증합니다. 두 체계가 같은 결론이면 같은 말을 반복하지 말고 "두 방식으로 봐도 같은 결을 가리킨다"는 식으로 짧게 묶어 말하고, 서로 다른 결론이면 그 차이 자체를 해석 재료로 씁니다(예: "사주로는 조직 안정형에 가깝지만, 자미두수 관록궁을 보면 혼자 결정하는 자리에서 오히려 힘을 발휘하는 구조라 — 조직 안에서도 재량권이 큰 역할일 때 더 잘 맞습니다").

[분량 기준]
- 기본 목표는 10,000~14,000자입니다. 지나온 구간이 많아 실제로 다룰 정보(과거 서사·가족·건강 등)가 풍부한 중장년층에 한해서만 15,000자 안팎까지 늘어날 수 있습니다.
- 분량을 채우기 위해 같은 내용을 반복하거나, 이 사람과 무관한 일반론을 끼워 넣거나, 정보가 거의 없는 먼 미래 구간을 억지로 부풀려 쓰지 않습니다. 다룰 내용이 실제로 적으면 그만큼만 짧게 쓰고 끝냅니다.

[가까운 미래의 정의 — 대운 단위가 아니라 실제 나이 기준]
- "가까운 미래"(4번 항목)는 대운 1개 구간이 아니라, 지금부터 약 3년을 가리킵니다.
- "그 다음 흐름"(5번 항목)은 그 이후 약 4~10년을 가리킵니다.
- 이 두 시기가 [평생 대운 전체 흐름 정보]의 어느 대운 나이대에 걸쳐 있는지 계산해서, 그 대운(들)의 오행·십성을 해석 근거로 사용합니다. 두 시기가 하나의 대운 안에 온전히 들어가면 그 대운 하나만, 대운 경계에 걸쳐 있으면 걸쳐 있는 두 대운의 기운을 함께 근거로 씁니다. 대운의 시작·종료 나이에 맞춰 "가까운 미래"의 정의 자체(약 3년, 약 4~10년)를 늘리거나 줄이지 않습니다.

[추천 출력 구조 — 아래 16개 항목을 전부 다루되, 분량 기준과 나이대별 상대적 중요도에 맞게 각 항목의 길이를 조절합니다]

1. 한 줄로 보는 이 사람 — 타고난 기질과 본질을 일간·오행·자미두수 명궁을 종합해 한 문단으로 압축.
2. 여기까지 오게 된 이야기 — "[이름 또는 '당신']님, 당신은 아마 이렇게 살아왔을 것입니다"로 시작. [평생 대운 전체 흐름 정보]의 "(이미 지나온 구간)"을 근거로, 나이대를 기계적으로 나열하지 않고 하나의 흐름 있는 이야기로 서술. 나이대별 구체적 사건은 날조하지 말고 성향·상황의 경향만 그림. 지나온 구간이 없거나 1개뿐이면 무리하게 늘리지 않음.
3. 지금 나는 어디에 서 있는가 (이 리포트의 중심) — "(현재 이 구간을 지나는 중)"으로 표시된 대운을 근거로, 지금 이 시기가 왜 지금의 나를 이렇게 만들고 있는지, 지금 겪고 있을 법한 심리적 국면·갈등·기회를 구체적으로.
4. 가까운 미래 (지금부터 약 3년) — 위 [가까운 미래의 정의]에 따라 계산한 시기를 가장 구체적이고 실감 나게. 준비해야 할 것, 조심해야 할 것을 실질적 톤으로.
5. 그 다음 흐름 (그 이후 약 4~10년) — 4번보다는 압축하되 여전히 구체적으로.
6. 인생 후반의 큰 흐름 — 그 이후 남은 구간들은 개별로 나열하지 않고 하나로 묶어 "삶 전체가 어떤 방향으로 흘러가는지"의 큰 그림으로만 짧게. (남은 구간이 없으면 생략)
7. 돈을 대하는 태도 — 사주 재성과 자미두수 재백궁을 교차검증해 이 사람의 전반적인 돈 그릇/습관/태도를 그림.
8. 지금 돈을 어떻게 움직여야 하는가 — 반드시 현재(3번)와 가까운 미래(4번) 시기를 기준으로, 재물 확장성 / 지켜야 하는 시기 / 위험 감수 성향 / 돈을 움직이는 속도 / 현금흐름 관리 방식을 설명. "투자해도 좋은 시기"나 "투자 조심 시기" 같은 표현은 쓰지 않습니다. 특정 금융상품·종목·코인·부동산 물건을 지목하지 않고, 매수·매도 등 구체적 행동을 지시하지 않습니다.
9. 일하는 방식 — 사주 관성·식상과 자미두수 관록궁을 교차검증해, 이 사람이 일할 때 편안함을 느끼는 방식(속도, 자율성, 관계 중심/성과 중심 등)을 그림.
10. 조직형인가 독립형인가 — 위 성향을 근거로 조직 안에서 성장하는 유형인지, 독립·자기 사업 쪽이 맞는 유형인지 구조적으로 짚음.
11. 이 사람에게 맞을 수 있는 직업군 3~5가지 — 반드시 "~해도 좋습니다/~을 고려해볼 만합니다"처럼 제안하는 톤으로, "~을 해야 합니다"처럼 단정하지 않음. 구체적 직업명이 아니라 직업군/분야로.
12. 이 사람을 지치게 하는 일 환경 — 위 성향과 반대되는 환경(예: 성과만 강조하는 조직, 관계 없이 혼자 일하는 구조 등)에서 이 사람이 어떻게 소진되는지.
13. 연애와 사람 — 성별에 따라 근거를 다르게 봅니다. 남성은 일지와 재성(정재·편재), 여성은 일지와 관성(정관·편관)을 기본으로 보되 명식 전체의 흐름과 함께 종합적으로 판단하고, 자미두수 부처궁과 교차검증해 연애 패턴과 인연이 무르익는 시기를 짚음.
14. 가족과 관계 — 부모궁·형제궁 등 관련 데이터가 있으면 근거로, 가족 안에서 이 사람이 맡아온·맡게 될 역할과 관계의 결을 짚음.
15. 건강과 에너지 관리 — 오행 편중·과다/부족 등 근거가 있으면, 건강 주의가 필요한 시기와 에너지 관리 방식을 짚음. (근거가 부족하면 무리하게 늘리지 않음)
16. 인생 전체 총평 — 2번에서 그린 지나온 삶과, 3~6번에서 다룬 현재~미래의 흐름을 하나로 엮어 마무리. "내가 지금까지 왜 이렇게 살아왔는지, 앞으로 무엇에 집중해야 하는지"가 드러나야 함.

[나이대별 상대적 중요도 — 퍼센트 배분이 아니라 무엇을 더 두껍게/얇게 쓸지에 대한 지시. 연령대 판단은 [현재 시점 기준] 만 나이를 최우선 기준으로 하고, 없으면 지나온 대운 구간 개수로 보조 판단(0~1개→10~20대, 2개→30대, 3~4개→40~50대, 5개 이상→60대 이상)]
- 10~20대: 과거(2번)는 짧게 다룹니다. 현재와 향후 10년(3~5번)을 가장 상세하고 길게 씁니다. 그보다 먼 미래(6번)는 짧게 다룹니다.
- 30대: 과거(2번)는 인생의 주요 전환점 위주로 압축해서 다룹니다. 현재와 향후 10년(3~5번)을 중심에 둡니다.
- 40~50대: 과거(2번)의 주요 흐름과 현재(3번)를 충분한 분량으로 다루고, 가까운 미래(4번)를 구체적으로 씁니다.
- 60대 이상: 지나온 삶(2번)을 충분히 정리하듯 다루면서, 현재와 남은 흐름(3~6번)을 중심으로 씁니다.
- 재물(7~8번)·직업(9~12번)·연애(13번)·가족(14번)·건강(15번)도 동일한 원칙을 따릅니다: 이 사람의 현재 나이에서 가깝고 실감 나는 내용(지금 상태, 가까운 미래)을 우선하고, 먼 과거의 세세한 사건이나 아주 먼 미래의 이야기는 상대적으로 짧게 다룹니다.
- 남은 인생 구간이 1~2개뿐이면 억지로 6번을 부풀리지 말고 있는 만큼만 다룹니다.

[대운 구간 관련 공통 규칙]
- 각 대운 구간을 다룰 때는 반드시 [평생 대운 전체 흐름 정보]에 실제로 나열된 나이대·간지·십성만 근거로 쓰고, 목록에 없는 나이대나 구간을 지어내지 않습니다.
- "(이미 지나온 구간)"은 2번에서, "(현재 이 구간을 지나는 중)"은 3번에서, "(앞으로 올 구간)"은 4~6번에서 각각 한 번씩만 다루고 중복 서술하지 않습니다.

[성공/실패 기준]
- 성공: 이 리포트를 읽은 사람이 "내가 지금까지 왜 이렇게 살아왔는지 알 것 같고, 앞으로 어디에 집중해야 하는지도 알겠다"라고 느낀다.
- 실패: "그냥 내 대운을 설명해놨네" 라는 인상을 준다.
`;

const CATEGORY_PROMPTS = {
  comprehensive: CATEGORY_PROMPT_COMPREHENSIVE,
  newyear: CATEGORY_PROMPT_NEWYEAR,
  today: CATEGORY_PROMPT_TODAY,
  wealth: CATEGORY_PROMPT_WEALTH,
  lifetime: CATEGORY_PROMPT_LIFETIME,
};

// ============================================================
// 반려동물궁합(pet) — BASE_PROMPT를 전혀 쓰지 않는 완전 독립 프롬프트.
// 이 서비스의 "재미로 보는" 킥 콘텐츠라, BASE_PROMPT의 진지한 역술가 톤·상투어 금지·양면성
// 필수 언급·확률적 어투 같은 규칙을 그대로 얹으면 오히려 딱딱해진다. 그래서 이 카테고리만
// BASE_PROMPT + 오버레이 구조를 타지 않고, 처음부터 끝까지 독립된 SYSTEM_PROMPT를 쓴다
// (module.exports 안의 분기 처리 참고). 다른 카테고리 프롬프트를 수정해도 이 프롬프트는
// 영향받지 않고, 반대로 이 프롬프트를 수정해도 다른 카테고리에는 영향이 없다.
// ============================================================
const PET_SYSTEM_PROMPT = `당신은 반려동물과 집사의 케미를 유쾌하고 사랑스럽게 풀어주는 "반려동물 궁합 작가"입니다. 여기는 진지한 명리학 상담이 아니라, 읽는 사람이 웃음 짓고 반려동물에 대한 애정이 더 커지도록 만드는 재미있고 행복한 콘텐츠입니다.

아래 규칙을 반드시 지켜 한국어로 작성하세요.

- 밝고 유쾌하며 다정한 어투로 씁니다. 존댓말을 쓰되 딱딱하지 않고, 친한 친구가 신나서 이야기해주는 듯한 톤으로 씁니다.
- 이모지를 자연스럽게 섞어 씁니다(문단당 1~2개 정도, 과하지 않게) — 🐾🐶🐱💛✨ 같은 반려동물·애정 관련 이모지를 활용하세요.
- 사주명리학 전문 용어(십성, 공망, 대운, 지장간, 일간 등)는 절대 쓰지 않습니다. 오직 [집사와 반려동물의 전통 궁합 관계]로 제공된 문장(합/충/동일/무난 여부)만 가볍게 참고하고, 나머지는 전부 재미있는 상상과 캐릭터성으로 풀어냅니다.
- 반려동물을 표정과 성격이 있는 캐릭터처럼 의인화해서 씁니다. 반려동물의 속마음을 상상해서 귀엽고 웃긴 대사로 따옴표 인용하는 것을 적극 활용하세요(예: "오늘도 집사 무릎은 내 자리야", "간식 내놔, 집사야").
- 절대 부정적이거나 불안하게 느껴지는 내용을 쓰지 않습니다. 전통적으로 "충(沖)" 관계라 해도 나쁘게 풀이하지 말고 "티격태격하는 게 매력인 코미디 케미", "서로 자극을 주는 활발한 궁합"처럼 반드시 긍정적이고 유쾌한 방향으로 재해석합니다. 걱정되거나 조심하라는 식의 조언은 쓰지 않습니다.
- 아래 5개 소제목을 이 순서대로, 각각 지정된 이모지+문구 그대로 사용해 다룹니다: "🎭 한마디로 이 조합은", "💭 [반려동물 이름]이의 속마음", "🌟 우리가 잘 맞는 이유", "🎁 더 친해지는 꿀팁", "🏆 총평 한 줄". ([반려동물 이름] 자리에는 실제 반려동물 이름을 넣으세요.)
- "🎭 한마디로 이 조합은" 섹션: 집사와 반려동물의 띠 관계(합/충/동일/무난)를 재미있는 비유로 소개하며 이 조합의 전체적인 케미를 3~4문장으로 유쾌하게 그립니다.
- "💭 [반려동물 이름]이의 속마음" 섹션: 반려동물의 시점에서 집사를 어떻게 생각하는지 귀엽고 웃긴 상상으로 풀어씁니다. 최소 2개 이상의 짧은 대사를 따옴표로 인용하세요.
- "🌟 우리가 잘 맞는 이유" 섹션: 둘 사이에 통하는 지점, 함께 있으면 좋은 점을 구체적이고 훈훈하게 풀어씁니다.
- "🎁 더 친해지는 꿀팁" 섹션: 함께 하면 좋은 활동이나 유대감을 높이는 재미있는 팁을 1~2가지 구체적으로 제안합니다(간식, 놀이, 산책, 스킨십 등 실제로 해볼 만한 것으로).
- "🏆 총평 한 줄" 섹션: 이 조합에 어울리는 재치있는 별명이나 한 줄 캐치프레이즈로 유쾌하게 마무리합니다(예: "이 조합은 사랑둥이 콤비!").
- 전체 분량은 900~1,300자 내외로, 짧고 산뜻하게 씁니다. 진지한 리포트처럼 길게 늘어지지 않습니다.
- "이 해석은 참고용" 같은 안내·면책 문구는 절대 붙이지 않습니다.
- 마크다운 문법(**, ##, - 목록 등)은 쓰지 않습니다. 소제목은 위에서 지정한 이모지+문구 형식만 그대로 쓰고, 별표나 샵 기호로 강조하지 않습니다.`;

// 카테고리별 max_tokens 상한. 대부분은 긴 리포트라 4000을 그대로 쓰지만, 오늘의 사주는
// 짧은 한 문단이라 낮게 잡아 출력 토큰 비용을 통제한다(구독자 수 × 365일 누적 구조).
const MAX_TOKENS_BY_CATEGORY = {
  today: 700,
  pet: 1800,
  lifetime: 8000,
};

// ============================================================
// 이어쓰기(continuation) — 분량 미달 대응
// 연애·재회운/궁합&결혼/신년운세/종합사주 카테고리 모두 gpt-4o-mini가 프롬프트에 지시한 목표
// 분량의 대략 40~70% 선에서 스스로 멈추는 경향이 반복 확인됐다(프롬프트 엔지니어링만으로는
// 한계 — 2026-08-20 gpt-4o로 테스트해봐도 마찬가지로 분량 미달이 나서, 모델 문제가 아니라
// 이 안전장치가 필요한 문제였음을 확인함). 모델을 바꾸지 않고, 1차 응답이 카테고리별 최소
// 분량에 못 미치면 방금 쓴 응답을 대화 맥락에 그대로 넣고 "이어서 더 써달라"는 후속 호출을
// 보내 그 결과를 이어 붙이는 방식으로 먼저 시도해본다. 카테고리별로 이어쓰기 최대 횟수를
// 다르게 둘 수 있도록 MAX_CONTINUATION_ROUNDS_BY_CATEGORY를 두며(기본은 기존과 동일하게
// 1회 — 무한 재시도 없음), 실패해도 이미 쓴 내용은 있으므로 그대로 반환한다.
const MIN_LENGTH_BY_CATEGORY = {
  comprehensive: 3000,
  love: 4000,
  compatibility: 3000,
  newyear: 3500,
  wealth: 3000,
  career: 3000,
  lifetime: 15000,
};

// 카테고리별 이어쓰기 최대 횟수. 평생운 프리미엄은 15,000자 이상을 목표로 하므로 1회
// 이어쓰기로는 부족해 최대 3회(최초 응답 포함 총 4회 호출)까지 허용한다. 여기 없는
// 카테고리는 DEFAULT_MAX_CONTINUATION_ROUNDS(기존과 동일한 1회)를 그대로 쓴다.
const MAX_CONTINUATION_ROUNDS_BY_CATEGORY = {
  lifetime: 3,
};
const DEFAULT_MAX_CONTINUATION_ROUNDS = 1;

const CONTINUATION_PROMPT = `방금 작성한 리포트가 목표 분량에 못 미칩니다. 아래 규칙을 지켜서 이어지는 내용만 추가로 작성하세요.

- 지금까지 쓴 내용을 그대로 반복하지 마세요.
- 이미 다룬 소주제 제목들을 다시 쓰거나 그 소주제를 처음부터 다시 설명하지 마세요. 대신, 앞에서 다룬 내용 중 아직 깊이 들어가지 못한 부분(더 구체적인 상황 묘사, 실제로 있을 법한 사례, 실천 가능한 조언)을 한두 가지 골라 새로운 문단으로 이어서 씁니다.
- 새로운 소제목을 만들지 말고, 소제목 형식("[짧은 주제어] — [문장]") 없이 본문 문단만 이어서 작성하세요.
- "이어서 말씀드리면", "추가로" 같은 메타 표현 없이 바로 본문 내용으로 시작하고, 마크다운 문법은 쓰지 마세요.`;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// gpt-4o-mini가 긴 한국어 텍스트를 생성할 때, 드물게 문장 중간에 한글과 전혀 무관한
// 스크립트(아랍어·키릴 문자·타이 문자 등) 토큰 하나를 잘못 골라 끼워 넣는 결함이 있다는
// 사용자 신고가 반복됨(2026-08-24). 이 서비스 결과물에는 한글·한자(사주 용어 병기)·라틴
// 문자/숫자·일반 문장부호만 정상적으로 등장하므로, 응답을 사용자에게 보여주기 전에
// 그 외 스크립트 범위를 후처리로 걸러낸다 — 근본 원인(모델의 토큰 선택 자체)은 고칠 수
// 없지만, 사용자가 실제로 보는 화면에 이런 글자가 노출되는 것은 이 안전망으로 막는다.
const UNEXPECTED_SCRIPT_RE = /[֐-׿؀-ۿ܀-ݏﭐ-﷿ﹰ-﻿ऀ-ॿঀ-৿਀-੿฀-๿Ѐ-ӿԀ-ԯ԰-֏Ⴀ-ჿሀ-፿]/g;
function sanitizeAiText(text) {
  if (!text) return text;
  const cleaned = text.replace(UNEXPECTED_SCRIPT_RE, '').replace(/[ \t]{2,}/g, ' ');
  if (cleaned !== text) {
    console.warn('AI 응답에서 예상치 못한 문자셋(아랍어/키릴/타이 등) 발견 — 제거 후 반환:', text);
  }
  return cleaned;
}

// 트래픽이 몰릴 때 OpenAI가 일시적으로 429(요청 과다)나 5xx(서버 오류)를 반환하는 경우가 있다.
// 이런 경우는 보통 몇 초 뒤 재시도하면 성공하므로, 최대 3번까지 지수 백오프(1초→2초)로
// 재시도한다. 400/401처럼 재시도해도 똑같이 실패할 요청 오류는 재시도하지 않고 바로 반환한다.
const OPENAI_RETRY_MAX_ATTEMPTS = 3;
const OPENAI_RETRY_BASE_DELAY_MS = 1000;

async function callOpenAIOnce(apiKey, messages, maxTokens, model) {
  // GPT-5 계열(gpt-5.4-mini 등)은 max_tokens 파라미터를 거부하고 max_completion_tokens를
  // 요구한다(2026-08-26 실측 확인 — max_tokens로 보내면 400 invalid_request_error /
  // unsupported_parameter). 모델명이 gpt-5로 시작하면 새 파라미터명을 쓴다.
  const tokenParamKey = /^gpt-5/.test(model) ? 'max_completion_tokens' : 'max_tokens';
  const openaiRes = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    // temperature를 기본값(1.0)보다 살짝 낮춰(0.8) 저확률·엉뚱한 토큰이 뽑힐 여지를 줄인다.
    // 문체의 다양성을 크게 해치지 않으면서, 위 sanitizeAiText와 함께 이중 안전장치 역할.
    body: JSON.stringify({ model, [tokenParamKey]: maxTokens, temperature: 0.8, messages }),
  });
  if (!openaiRes.ok) {
    const errText = await openaiRes.text();
    console.error('OpenAI API error:', openaiRes.status, errText);
    return { ok: false, status: openaiRes.status };
  }
  const data = await openaiRes.json();
  const rawText = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
  const text = sanitizeAiText(rawText);
  return { ok: true, text };
}

// 재시도할 가치가 있는 오류인지 판단: 429(rate limit)나 5xx(서버 쪽 일시적 오류), 그리고
// status 0(=fetch 자체가 실패한 네트워크 순단)만 재시도. 4xx(400/401/403 등 요청 자체의
// 문제)는 다시 시도해도 똑같이 실패하므로 재시도하지 않는다.
function isRetryableStatus(status) {
  return status === 0 || status === 429 || (status >= 500 && status < 600);
}

async function callOpenAI(apiKey, messages, maxTokens, model) {
  let lastResult = null;
  for (let attempt = 1; attempt <= OPENAI_RETRY_MAX_ATTEMPTS; attempt++) {
    let result;
    try {
      result = await callOpenAIOnce(apiKey, messages, maxTokens, model);
    } catch (networkErr) {
      // fetch 자체가 실패한 경우(네트워크 순단 등)도 재시도 대상으로 취급
      console.error(`OpenAI 호출 네트워크 오류 (시도 ${attempt}/${OPENAI_RETRY_MAX_ATTEMPTS}):`, networkErr);
      result = { ok: false, status: 0 };
    }
    if (result.ok) return result;
    lastResult = result;
    const isLastAttempt = attempt === OPENAI_RETRY_MAX_ATTEMPTS;
    if (isLastAttempt || !isRetryableStatus(result.status)) break;
    const delay = OPENAI_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1); // 1초 → 2초
    console.warn(`OpenAI ${result.status} 응답 — ${delay}ms 후 재시도 (${attempt}/${OPENAI_RETRY_MAX_ATTEMPTS})`);
    await sleep(delay);
  }
  return lastResult;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST 요청만 지원합니다.' });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: '서버에 OPENAI_API_KEY 환경변수가 설정되어 있지 않습니다.' });
    return;
  }

  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    res.status(400).json({ error: '요청 본문을 해석할 수 없습니다.' });
    return;
  }

  if (!payload || !payload.saju) {
    res.status(400).json({ error: '사주 데이터가 없습니다.' });
    return;
  }

  // 비회원도 구매할 수 있다(2026-08-25). access_token이 있으면(로그인 사용자) Supabase Auth에
  // 되물어 검증하고, 검증된 user.id만 신뢰한다(클라이언트가 보낸 user_id는 쓰지 않음). 토큰이
  // 없거나 검증에 실패하면 비회원으로 간주하고 계속 진행한다(결제 기록은 user_id 없이 남는다).
  const user = payload.access_token ? await verifySupabaseUser(payload.access_token) : null;

  // 관리자 계정은 결제 없이 심층풀이를 볼 수 있다(2026-09-24). user가 이미 서버에서 검증된
  // 계정일 때만 profiles.is_admin을 다시 조회하므로, 로그인하지 않았거나 access_token이
  // 유효하지 않은 요청은 절대 이 분기를 탈 수 없다.
  const isAdmin = user ? await checkIsAdmin(user.id) : false;

  // 반려동물궁합(pet)은 BASE_PROMPT + 오버레이 구조를 아예 타지 않는 완전 독립 프롬프트라
  // (위 PET_SYSTEM_PROMPT 주석 참고) 여기서 따로 분기한다. userPrompt도 무거운 원국 데이터
  // 대신 buildPetPrompt()가 만든 간단한 텍스트를 쓴다.
  let userPrompt, SYSTEM_PROMPT;
  if (payload.category === 'pet') {
    userPrompt = buildPetPrompt(payload);
    SYSTEM_PROMPT = PET_SYSTEM_PROMPT;
  } else {
    userPrompt = buildPrompt(payload);
    const categoryPrompt = payload.category === 'love'
      ? buildCategoryPromptLove(payload.loveStatus)
      : payload.category === 'compatibility'
        ? buildCategoryPromptCompatibility(payload.name, payload.partner && payload.partner.name)
        : payload.category === 'career'
          ? buildCategoryPromptCareer(payload.jobStatus)
          : (CATEGORY_PROMPTS[payload.category] || CATEGORY_PROMPT_COMPREHENSIVE);
    SYSTEM_PROMPT = BASE_PROMPT + '\n' + categoryPrompt;
  }

  const maxTokens = MAX_TOKENS_BY_CATEGORY[payload.category] || 4000;
  const model = MODEL_BY_CATEGORY[payload.category] || DEFAULT_MODEL;
  const amount = CATEGORY_AMOUNT_KRW[payload.category] || CATEGORY_AMOUNT_KRW.comprehensive;
  // 관리자 무료 열람 기록용 금액. 실제 매출 통계(결제 요약 합계 등)를 왜곡하지 않도록
  // 0원으로 남긴다 — 아래 두 recordPurchase 호출부에서 amount 대신 이 값을 쓴다.
  const recordAmount = isAdmin ? 0 : amount;

  // 2026-08-30: 결제 검증 게이트. OpenAI를 호출(=과금)하기 전에 먼저 포트원에서 실제 결제
  // 완료 여부를 확인한다. paymentId가 없거나 검증에 실패하면 AI 해석을 아예 생성하지 않는다.
  // 2026-09-24: 단, 관리자 계정(위 checkIsAdmin으로 서버가 직접 재검증한 값만 신뢰)은 이
  // 게이트를 건너뛰어 결제 없이 바로 심층풀이를 볼 수 있게 한다.
  const paymentCheck = isAdmin ? { ok: true } : await verifyPortOnePayment(payload.paymentId, amount);
  if (!paymentCheck.ok) {
    res.status(402).json({ error: `결제 확인에 실패했습니다. (${paymentCheck.reason})` });
    return;
  }

  // 2026-09-25: 보안 조치 — 결제 자체는 유효해도 이미 다른 요청에 한 번 쓰인 paymentId라면
  // 차단한다(관리자 무료열람은 실제 paymentId가 없으므로 제외). 배경은 위
  // isPaymentAlreadyUsed() 주석 참고.
  if (!isAdmin && await isPaymentAlreadyUsed(payload.paymentId)) {
    res.status(409).json({ error: '이미 사용된 결제입니다. 같은 결제로 다시 요청할 수 없습니다.' });
    return;
  }

  // access_token이 payload에 그대로 있으면 DB에 시크릿 성격의 값이 남으므로, 결제 검증
  // 통과 직후(=이 시점부터는 실제로 돈이 청구된 결제라 아래 어떤 경로로 끝나든 흔적을
  // 남겨야 하므로) 미리 한 번만 떼어둔다.
  const { access_token, ...payloadWithoutToken } = payload;

  try {
    const first = await callOpenAI(apiKey, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ], maxTokens, model);

    if (!first.ok) {
      // 2026-09-24 안전장치: 여기 도달했다는 건 바로 위 verifyPortOnePayment()가 이미
      // 통과했다는 뜻 — 즉 결제(청구)는 실제로 이미 끝난 상태인데, OpenAI 호출이 끝내
      // 실패해서 심층풀이를 못 만든 경우다. 예전엔 이 분기에서 바로 502를 반환하고 끝났기
      // 때문에, 실제로 결제된 건이 purchases 테이블에 단 한 줄도 안 남는 문제가 있었다
      // (2026-09-24 실제 사고: OpenAI 계정 크레딧 소진으로 결제 2건이 이렇게 흔적 없이
      // 누락되어, 고객은 결제했는데 아무 결과도 못 받고 CS/관리자 페이지에서도 추적이
      // 전혀 안 되는 상황이 발생했음). 결제 검증·금액·카테고리·계산 로직은 전혀 건드리지
      // 않고, 이 실패를 status:'failed'로 최소한 기록만 남긴다 — recordPurchase 자체가
      // 실패해도(Supabase 오류 등) 원래의 502 응답에는 절대 영향을 주지 않도록 감싼다.
      try {
        await recordPurchase({
          userId: user ? user.id : null,
          category: payload.category || 'comprehensive',
          amount: recordAmount,
          payload: payloadWithoutToken,
          resultText: isAdmin
            ? '[AI 생성 실패 — 관리자 무료 열람]'
            : `[AI 생성 실패 — 결제는 완료됨] OpenAI 응답 오류 (status ${first.status})`,
          visitorId: payload.visitorId || null,
          status: 'failed',
          pgProvider: isAdmin ? 'admin_bypass' : 'portone_inicis',
          paymentId: payload.paymentId || null,
        });
      } catch (recordErr) {
        console.error('failed-purchase 기록 중 오류(원래 502 응답에는 영향 없음):', recordErr);
      }
      res.status(502).json({ error: `AI 서버 응답 오류 (${first.status})` });
      return;
    }

    let text = first.text;

    // 이어쓰기: 카테고리별 최소 분량에 못 미치면 후속 호출을 보내 이어 붙인다. 카테고리별로
    // 최대 이어쓰기 횟수가 다를 수 있으므로(대부분 1회, 평생운 프리미엄은 3회) 반복문으로 처리한다.
    // 기존 카테고리는 MAX_CONTINUATION_ROUNDS_BY_CATEGORY에 없으므로 DEFAULT_MAX_CONTINUATION_ROUNDS(1)가
    // 적용되어 이전과 동일하게 최대 1회만 이어쓴다.
    const minLen = MIN_LENGTH_BY_CATEGORY[payload.category];
    const maxContinuationRounds = MAX_CONTINUATION_ROUNDS_BY_CATEGORY[payload.category] || DEFAULT_MAX_CONTINUATION_ROUNDS;
    let continuationRounds = 0;
    while (minLen && text.length < minLen && continuationRounds < maxContinuationRounds) {
      try {
        const cont = await callOpenAI(apiKey, [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
          { role: 'assistant', content: text },
          { role: 'user', content: CONTINUATION_PROMPT },
        ], maxTokens, model);
        continuationRounds++;
        if (cont.ok && cont.text) {
          text = text + '\n\n' + cont.text;
        } else {
          break;
        }
      } catch (contErr) {
        // 이어쓰기 호출이 실패해도 지금까지 쓴 내용은 있으므로 그대로 반환한다.
        console.error('continuation call failed:', contErr);
        break;
      }
    }

    const finalText = text || '해석을 생성하지 못했습니다.';

    // 결제 기록 + 재열람용 캐시 저장. access_token 검증을 통과한 사용자이므로 여기서만 기록한다.
    await recordPurchase({
      userId: user ? user.id : null,
      category: payload.category || 'comprehensive',
      amount: recordAmount,
      payload: payloadWithoutToken,
      resultText: finalText,
      visitorId: payload.visitorId || null,
      pgProvider: isAdmin ? 'admin_bypass' : 'portone_inicis',
      paymentId: payload.paymentId || null,
    });

    res.status(200).json({ interpretation: finalText });
  } catch (err) {
    console.error('interpret.js error:', err);
    res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
  }
};
