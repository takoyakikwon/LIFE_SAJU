/**
 * api/interpret.js(Vercel 서버리스 함수)의 내부 함수를 Node vm 샌드박스에서 꺼내 쓰는 로더.
 * tests/_engine_loader.js(index.html 엔진용)와 같은 패턴 — 파일 끝에 export 캡처 줄을
 * 문자열로 덧붙여서 실행하고, module.exports에서 필요한 함수만 꺼낸다. fetch는 비활성화
 * 상태로 주입한다(테스트에서 실제 OpenAI/Supabase/PortOne 호출이 일어나면 안 되므로) — 이
 * 로더로 꺼내는 함수들(buildPrompt/buildPersonProfileNarrativeBlock 등)은 순수 문자열 조립
 * 함수라 네트워크를 전혀 쓰지 않는다.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INTERPRET_JS_PATH = path.join(__dirname, '..', 'api', 'interpret.js');

const EXPORT_NAMES = [
  'buildPrompt', 'buildPersonProfileNarrativeBlock', 'formatMyeongriCrossEvidence',
  'NARRATIVE_V3_BASE_PROMPT',
  // 2026-10 "최종 보정" — 카테고리별 V3 프롬프트(와 함수형 2개)·분량 설정까지 테스트에서
  // 직접 검증할 수 있도록 추가로 꺼낸다. 상수 그대로 꺼내는 것일 뿐 새 동작을 추가하지 않는다.
  'CATEGORY_PROMPT_COMPREHENSIVE_V3', 'CATEGORY_PROMPT_WEALTH_V3', 'CATEGORY_PROMPT_LIFETIME_V3',
  'CATEGORY_PROMPT_NEWYEAR_V3', 'buildCategoryPromptLoveV3', 'buildCategoryPromptCareerV3',
  'buildCategoryPromptCompatibilityV3', 'MIN_LENGTH_BY_CATEGORY', 'MAX_CONTINUATION_ROUNDS_BY_CATEGORY',
];

function loadInterpretModule() {
  const src = fs.readFileSync(INTERPRET_JS_PATH, 'utf8');
  const patched = src + `\nmodule.exports.__test = { ${EXPORT_NAMES.join(', ')} };\n`;
  const sandbox = {
    module: { exports: {} }, require, process, console,
    fetch: () => Promise.reject(new Error('fetch disabled in test sandbox')),
    URL, URLSearchParams,
  };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(patched, sandbox, { filename: 'interpret.js#test', timeout: 20000 });
  return sandbox.module.exports.__test;
}

module.exports = { loadInterpretModule };
