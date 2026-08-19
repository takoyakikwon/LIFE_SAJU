// Vercel 서버리스 함수: 사주/자미두수 데이터를 받아 OpenAI API로 해석 텍스트를 생성합니다.
// 배포 시 Vercel 프로젝트의 환경변수(Settings > Environment Variables)에
//   OPENAI_API_KEY = sk-...
// 를 반드시 설정해야 동작합니다. (https://platform.openai.com/api-keys 에서 발급)
//
// 이 파일은 Node.js 런타임의 Vercel 서버리스 함수 형식(module.exports = async (req,res)=>{...})입니다.

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
// 필요 시 환경변수로 모델을 바꿀 수 있게 해둠. gpt-4o-mini는 저렴하면서 이런 글쓰기 작업엔 충분합니다.
// 더 높은 품질을 원하면 Vercel 환경변수에 OPENAI_MODEL=gpt-4o 등으로 지정하세요.
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function buildPrompt(payload) {
  const { name, gender, birth, saju, ziwei } = payload;

  const lines = [];
  lines.push(`이름: ${name || '(비공개)'}`);
  lines.push(`성별: ${gender}`);
  lines.push(`생년월일시: ${birth}`);
  lines.push('');
  lines.push('[사주팔자 기본]');
  if (saju) {
    lines.push(`년주 ${saju.년주} / 월주 ${saju.월주} / 일주 ${saju.일주} / 시주 ${saju.시주}`);
    lines.push(`일간(나): ${saju.일간}`);
    lines.push(`오행 분포: ${saju.오행분포}`);
    if (saju.현재대운) lines.push(`현재 대운: ${saju.현재대운}`);
    if (saju.공망) lines.push(`공망: ${saju.공망}`);
    if (saju.사주상세) {
      lines.push('');
      lines.push('[사주팔자 상세 — 8자 각각의 십성/지장간/12운성]');
      lines.push(saju.사주상세);
    }
  }
  if (ziwei) {
    lines.push('');
    lines.push('[자미두수 기본]');
    lines.push(`음력 생일: ${ziwei.음력생일}`);
    lines.push(`오행국: ${ziwei.오행국}`);
    lines.push(`명궁: ${ziwei.명궁}`);
    if (ziwei.신궁) lines.push(`신궁: ${ziwei.신궁}`);
    if (ziwei.명궁의별) lines.push(`명궁에 있는 별: ${ziwei.명궁의별}`);
    if (ziwei.사화) lines.push(`사화: ${ziwei.사화}`);
    if (ziwei.현재대한) lines.push(`현재 대한: ${ziwei.현재대한}`);
    if (ziwei.궁위상세) {
      lines.push('');
      lines.push('[자미두수 12궁 전체 상세 — 각 궁의 지지와 포함된 별]');
      lines.push(ziwei.궁위상세);
    }
  }

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
- 성격이나 흐름을 설명할 때는 "일간이 庚金이고 亥월생입니다", "관록궁에 천부가 있습니다" 처럼 실제 제공된 데이터를 구체적으로 인용한 뒤에 해석을 붙입니다. 근거 없이 뭉뚱그린 성격 묘사만 나열하지 않습니다.
- 이 사람이 스스로에게 할 법한 혼잣말이나, 주변 사람이 이 사람에 대해 할 법한 말을 자연스럽게 따옴표로 인용해 몰입감을 높입니다. (예: "내가 왜 이걸 해야 하지?", "저 사람 생각보다 고집이 있네")
- 단정적 예언("반드시 ~합니다", "100% ~")은 피하고 "~가능성이 높습니다", "~일 수 있습니다" 같은 확률적 어투를 씁니다.
- 미신적으로 겁을 주거나("이 시기에 큰 사고를 조심하세요" 류의 구체적 위협) 불안을 조장하는 문장은 쓰지 않습니다. 특히 건강 관련 내용은 특정 질병을 지목하지 않고 "컨디션 관리에 신경 쓰면 좋은 시기" 정도로 순화합니다.
- 각 소제목은 "[짧은 주제어] — [그 섹션의 핵심 통찰을 담은 한 문장]" 형식으로 씁니다 (예: "기본 성격 — 단단한데 속은 생각보다 복잡합니다"). 소제목은 별도의 줄에 쓰고, 다음 줄부터 본문 문단을 씁니다. 소제목 사이는 빈 줄로 구분합니다.
- 마크다운 문법(**, ##, - 목록 등)을 절대 쓰지 마세요. 소제목을 포함해 모든 텍스트는 순수 텍스트로만 작성합니다. 별표나 샵 기호로 강조하지 않습니다.
- 아래에서 지정한 도입부와 소주제 구성 외에, "비공식적인 리포트" 같은 별도의 안내 문구나 머리말 섹션을 임의로 추가하지 마세요. 정해진 구조만 그대로 따릅니다.
- 전체 글의 맨 마지막에 한 문장으로, 이 해석은 전통 명리학에 기반한 참고용 콘텐츠이며 중요한 결정은 본인의 판단을 따르라는 안내를 자연스럽게 덧붙입니다.`;

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
- 아래 5개 소주제를 이 순서대로 다룹니다: "감정을 표현하는 방식", "지금 이 사람의 연애 흐름", "마음이 자주 흔들리는 지점", "${s.subtitle}", "다가오는 시기와 총평".
- "${s.subtitle}" 섹션 지침: ${s.guide}
- 각 소주제는 최소 5~7문장 이상으로, 근거 데이터 인용 → 그 의미 해석 → 구체적인 상황 묘사나 조언까지 충분히 풀어서 씁니다. 짧게 요약하듯 끝내지 말고 각 소주제마다 문단을 2개 이상으로 나눠도 좋습니다.
- 전체 분량은 2,800~3,600자 내외로, 다른 카테고리 못지않게 충분히 길고 깊이 있게 작성합니다.
- 마지막 소주제("다가오는 시기와 총평")에서 앞선 내용을 종합해 마무리합니다.`;
}

const CATEGORY_PROMPTS = {
  comprehensive: CATEGORY_PROMPT_COMPREHENSIVE,
};

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

  const userPrompt = buildPrompt(payload);
  const categoryPrompt = payload.category === 'love'
    ? buildCategoryPromptLove(payload.loveStatus)
    : (CATEGORY_PROMPTS[payload.category] || CATEGORY_PROMPT_COMPREHENSIVE);
  const SYSTEM_PROMPT = BASE_PROMPT + '\n' + categoryPrompt;

  try {
    const openaiRes = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error('OpenAI API error:', openaiRes.status, errText);
      res.status(502).json({ error: `AI 서버 응답 오류 (${openaiRes.status})` });
      return;
    }

    const data = await openaiRes.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();

    res.status(200).json({ interpretation: text || '해석을 생성하지 못했습니다.' });
  } catch (err) {
    console.error('interpret.js error:', err);
    res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
  }
};
