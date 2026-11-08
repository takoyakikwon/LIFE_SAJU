'use strict';
// 사주결 부적 이미지 생성기 (2026-11). 결제가 검증된 요청에만 api/interpret.js 가 호출한다.
// 글자 윤곽은 _talisman_glyphs.js(Noto Serif CJK KR Bold, OFL)에서 가져와 SVG 경로로 직접 그린다 —
// 글꼴 파일이나 외부 이미지를 쓰지 않으므로 같은 입력이면 언제나 같은 이미지가 나온다.
// 파일 이름이 _ 로 시작하면 Vercel 이 별도 API 경로로 만들지 않는다(다른 파일이 불러 쓰기만 함).
const GLYPHS = require('./_talisman_glyphs.js');
const UPM = 1000;

const ELEMENTS = ['木', '火', '土', '金', '水'];
const KIND_KEYS = ['pass', 'wealth', 'match'];
// 목적별로 바뀌는 오른쪽 기둥 글(전통적으로 쓰이는 길상 문구). 궁합은 목적이 없다.
const PURPOSES = {
  pass: {
    univ: { label: '대학 합격', right: '學業成就如意' },
    job: { label: '취업·면접', right: '所願成就如意' },
    exam: { label: '공무원·자격증', right: '金榜題名' },
    move: { label: '승진·이직', right: '萬事亨通' },
  },
  wealth: {
    biz: { label: '사업·장사', right: '金玉滿堂' },
    home: { label: '내 집·큰 계약', right: '家門隆昌' },
    save: { label: '저축·재테크', right: '積小成大' },
    pay: { label: '월급·이직', right: '福祿雙全' },
  },
  match: { love: { label: '인연·궁합', right: '天作之合' } },
};
const KINDS = {
  pass: { name: '합격 부적', center: ['合', '格'], left: '天地神明護佑', paper: 'pg-h', ink: '#a3231a', sealBg: '#a3231a', sealFg: '#efd68f', tint: '#d8b660', fx: [0.5, 0.34, 0.12], vig: 'vig-l' },
  wealth: { name: '재물 부적', center: ['財', '福'], left: '財源廣進', paper: 'pg-j', ink: '#e6c36a', sealBg: '#e6c36a', sealFg: '#1d2444', tint: '#3b4a8a', fx: [0.75, 0.65, 0.35], vig: 'vig-d' },
  match: { name: '궁합 부적', center: ['良', '緣'], left: '百年佳約', paper: 'pg-g', ink: '#9c2646', sealBg: '#9c2646', sealFg: '#f6dbd2', tint: '#e6b3a6', fx: [0.62, 0.38, 0.32], vig: 'vig-l' },
};

function glyph(ch, cx, base, size, fill) {
  const g = GLYPHS[ch];
  if (!g) throw new Error('no glyph: ' + ch);
  const s = size / UPM;
  return `<path d="${g[0]}" transform="translate(${(cx - g[1] * s / 2).toFixed(2)},${base.toFixed(2)}) scale(${s.toFixed(5)},${(-s).toFixed(5)})"${fill ? ` fill="${fill}"` : ''}/>`;
}
function column(text, cx, y0, step, size) {
  return Array.from(text).map((c, i) => glyph(c, cx, y0 + i * step, size)).join('');
}
function row(text, base, cxs, size) {
  return Array.from(text).map((c, i) => glyph(c, cxs[i], base, size)).join('');
}
function col2(text, cx, size) {
  const n = Array.from(text).length;
  const step = n >= 6 ? 29 : 36;
  const y0 = 215 - (n - 1) * step / 2 + size * 0.36;
  return column(text, cx, y0, step, size);
}
function range(a, b, st) { const r = []; for (let x = a; x < b; x += st) r.push(x); return r; }

const PATTERNS = {
  '水': '<path d="M30 373 q8 -9 16 0 t16 0 t16 0 t16 0 t16 0 t16 0 M30 383 q8 -9 16 0 t16 0 t16 0 t16 0 t16 0 t16 0" fill="none" stroke-width="1.7" stroke-linecap="round"/>',
  '木': '<path d="M30 384 C60 368 90 392 120 374 S150 384 168 374" fill="none" stroke-width="1.7" stroke-linecap="round"/>' +
    [[48, 378], [76, 383], [104, 372], [132, 380], [158, 372]].map(([x, y]) => `<path d="M${x} ${y} q6 -10 12 -2 q-5 8 -12 2z" stroke-width="1"/>`).join(''),
  '火': range(34, 170, 22).map((x) => `<path d="M${x} 387 q-4 -6 0 -12 q2 4 5 6 q2 -5 -1 -9 q7 5 5 15z" stroke-width="1"/>`).join(''),
  '土': range(34, 170, 24).map((x) => `<path d="M${x} 386 l10 -16 l10 16z" stroke-width="1.4" fill="none"/>`).join('') + '<path d="M30 386 H170" stroke-width="1.6"/>',
  '金': range(46, 170, 32).map((x) => `<circle cx="${x}" cy="378" r="7" stroke-width="1.5" fill="none"/><circle cx="${x}" cy="378" r="2.3" stroke-width="1"/>`).join(''),
};

function dipper() {
  const pts = [[46, 52], [64, 57], [82, 51], [100, 58], [136, 60], [141, 43], [103, 40]];
  const line = 'M' + pts.slice(0, 5).map(([x, y]) => `${x} ${y}`).join(' L') + ` L${pts[5][0]} ${pts[5][1]} L${pts[6][0]} ${pts[6][1]} L${pts[3][0]} ${pts[3][1]}`;
  const dots = pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.1"/>`).join('');
  return `<path d="${line}" fill="none" stroke-width="1.1" opacity=".8"/>${dots}`;
}

function paperFx(id, [r, g, b]) {
  return `<filter id="${id}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.011 0.018" numOctaves="2" seed="4" result="m"/><feColorMatrix in="m" type="matrix" values="0 0 0 0 ${r}  0 0 0 0 ${g}  0 0 0 0 ${b}  0 0 0 1.1 -.42" result="mot"/><feTurbulence type="fractalNoise" baseFrequency="0.85 0.22" numOctaves="3" seed="7" result="n"/><feColorMatrix in="n" type="matrix" values="0 0 0 0 ${r}  0 0 0 0 ${g}  0 0 0 0 ${b}  0 0 0 .9 -.3" result="fib"/><feMerge><feMergeNode in="mot"/><feMergeNode in="fib"/></feMerge></filter>`;
}
const DEFS = '<defs>' +
  '<linearGradient id="pg-h" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f2e0a8"/><stop offset=".55" stop-color="#ecd58f"/><stop offset="1" stop-color="#e2c57c"/></linearGradient>' +
  '<linearGradient id="pg-j" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#26305f"/><stop offset=".55" stop-color="#1d2547"/><stop offset="1" stop-color="#151b38"/></linearGradient>' +
  '<linearGradient id="pg-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f8e4dc"/><stop offset=".55" stop-color="#f1d3c9"/><stop offset="1" stop-color="#e8c0b3"/></linearGradient>' +
  '<radialGradient id="vig-l" cx=".5" cy=".5" r=".72"><stop offset=".55" stop-color="#7a4e12" stop-opacity="0"/><stop offset="1" stop-color="#6b4210" stop-opacity=".38"/></radialGradient>' +
  '<radialGradient id="vig-d" cx=".5" cy=".5" r=".72"><stop offset=".5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".5"/></radialGradient>' +
  '<filter id="ink" x="-4%" y="-4%" width="108%" height="108%"><feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="2" seed="2" result="w"/><feDisplacementMap in="SourceGraphic" in2="w" scale="2.4" xChannelSelector="R" yChannelSelector="G" result="d"/><feTurbulence type="fractalNoise" baseFrequency="0.6" numOctaves="2" seed="9" result="g"/><feColorMatrix in="g" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.2 2.32" result="gm"/><feComposite in="d" in2="gm" operator="in"/></filter>' +
  '</defs>';

function seal(K, x, y, ch, rot) {
  return `<g filter="url(#ink)" transform="translate(${x} ${y}) rotate(${rot} 17 17)"><rect x="0" y="0" width="34" height="34" fill="${K.sealBg}"/><rect x="2.6" y="2.6" width="28.8" height="28.8" fill="none" stroke="${K.sealFg}" stroke-width=".9"/><g transform="translate(17 26)">${glyph(ch, 0, 0, 22, K.sealFg)}</g></g>`;
}

// 입력 검증: 잘못된 값은 던진다(호출하는 쪽이 400 으로 바꾼다).
function normalize(opts) {
  const kind = opts && opts.kind;
  if (KIND_KEYS.indexOf(kind) < 0) throw new Error('bad_kind');
  const el = opts.el;
  if (ELEMENTS.indexOf(el) < 0) throw new Error('bad_element');
  let el2 = null;
  if (kind === 'match') {
    el2 = opts.el2;
    if (ELEMENTS.indexOf(el2) < 0) throw new Error('bad_element2');
  }
  const purposeKey = kind === 'match' ? 'love' : opts.purpose;
  if (!PURPOSES[kind][purposeKey]) throw new Error('bad_purpose');
  let dateText = String(opts.year || '');
  if (kind === 'pass' && opts.date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(opts.date));
    if (!m) throw new Error('bad_date');
    const y = +m[1], mo = +m[2], d = +m[3];
    if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) throw new Error('bad_date');
    dateText = `${y} · ${String(mo).padStart(2, '0')} · ${String(d).padStart(2, '0')}`;
  }
  if (!/^\d{4}( · \d{2} · \d{2})?$/.test(dateText)) throw new Error('bad_year');
  return { kind, el, el2, purposeKey, dateText };
}

function buildTalismanSvg(opts) {
  const { kind, el, el2, purposeKey, dateText } = normalize(opts);
  const K = KINDS[kind];
  const right = PURPOSES[kind][purposeKey].right;
  const seals = el2 ? seal(K, 150, 337, el, -5) + seal(K, 184, 335, el2, 3) : seal(K, 176, 335, el, -4);
  const fxId = 'fx';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 420" width="960" height="1680">` +
    DEFS.replace('</defs>', paperFx(fxId, K.fx) + '</defs>') +
    `<rect x="0" y="0" width="240" height="420" rx="3" fill="url(#${K.paper})"/>` +
    `<rect x="0" y="0" width="240" height="420" rx="3" fill="${K.tint}" filter="url(#${fxId})" opacity=".42"/>` +
    `<rect x="0" y="0" width="240" height="420" rx="3" fill="url(#${K.vig})"/>` +
    `<g fill="${K.ink}" stroke="${K.ink}" filter="url(#ink)">` +
    '<rect x="11" y="11" width="218" height="398" fill="none" stroke-width="2.8"/>' +
    '<rect x="18" y="18" width="204" height="384" fill="none" stroke-width="1"/>' +
    '<path d="M11 11h14v6h-8v8h-6z M229 11h-14v6h8v8h6z M11 409h14v-6h-8v-8h-6z M229 409h-14v-6h8v-8h6z" stroke="none"/>' +
    dipper() +
    `<g stroke="none">${row('勅令', 98, [100, 140], 30)}</g>` +
    '<path d="M30 110H210" fill="none" stroke-width="1.4"/>' +
    `<g stroke="none">${glyph(K.center[0], 120, 207, 104)}${glyph(K.center[1], 120, 311, 104)}${col2(K.left, 34, 17)}${col2(right, 206, 17)}</g>` +
    '<path d="M30 334H210" fill="none" stroke-width="1.4"/>' +
    `<g stroke="none">${row('急急如律令', 358, [60, 78, 96, 114, 132], 16)}</g>` +
    `<g>${PATTERNS[el]}</g></g>` +
    seals +
    `<text x="120" y="398" text-anchor="middle" font-size="8.4" fill="${K.ink}" opacity=".85" letter-spacing="1.6" font-family="'Noto Sans KR','Apple SD Gothic Neo','Malgun Gothic',sans-serif">${dateText}</text>` +
    '</svg>';
}

module.exports = { buildTalismanSvg, normalize, ELEMENTS, KIND_KEYS, PURPOSES, KINDS, TALISMAN_PRICE_KRW: 990 };
