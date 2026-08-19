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
    lines.push('[사주팔자]');
    if (saju) {
          lines.push(`년주 ${saju.년주} / 월주 ${saju.월주} / 일주 ${saju.일주} / 시주 ${saju.시주}`);
          lines.push(`일간(나): ${saju.일간}`);
          lines.push(`오행 분포: ${saju.오행분포}`);
          if (saju.현재대운) lines.push(`현재 대운: ${saju.현재대운}`);
    }
    if (ziwei) {
          lines.push('');
          lines.push('[자미두수]');
          lines.push(`음력 생일: ${ziwei.음력생일}`);
          lines.push(`오행국: ${ziwei.오행국}`);
          lines.push(`명궁: ${ziwei.명궁}`);
          if (ziwei.명궁의별) lines.push(`명궁에 있는 별: ${ziwei.명궁의별}`);
          if (ziwei.사화) lines.push(`사화: ${ziwei.사화}`);
    }

  return lines.join('\n');
}

const SYSTEM_PROMPT = `당신은 전통 명리학(사주팔자)과 자미두수에 두루 밝은, 따뜻하고 신중한 상담가입니다.
아래 규칙을 지켜 한국어로 사주 해석을 작성하세요.

- 존댓말, 따뜻하고 담백한 문체를 씁니다. 과장되거나 단정적인 예언("반드시 ~합니다", "100% ~") 표현은 피합니다.
- 미신적으로 겁을 주거나("이 시기에 큰 사고를 조심하세요" 류의 구체적 위협) 불안을 조장하는 문장은 쓰지 않습니다.
- 다음 순서로, 소제목 없이 자연스러운 산문 4~5개 문단으로 씁니다: (1) 타고난 기질과 성격, (2) 강점, (3) 조심하면 좋은 경향, (4) 지금 흐름(현재 대운), (5) 마무리 총평.
- 사주와 자미두수 두 자료가 모두 주어졌다면 두 체계에서 공통적으로 보이는 특징을 우선하고, 서로 다른 부분이 있다면 "이런 면과 저런 면이 함께 있을 수 있다"는 식으로 균형 있게 다룹니다.
- 전체 길이는 800~1200자 내외로 씁니다.
- 마지막에 한 문장으로, 이 해석은 전통 명리학에 기반한 참고·재미용 콘텐츠이며 중요한 결정은 본인의 판단을 따르라는 안내를 자연스럽게 덧붙입니다.`;

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

    try {
          const openaiRes = await fetch(OPENAI_API_URL, {
                  method: 'POST',
                  headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${apiKey}`,
                  },
                  body: JSON.stringify({
                            model: MODEL,
                            max_tokens: 1500,
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
