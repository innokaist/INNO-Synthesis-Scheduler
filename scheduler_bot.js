/* =====================================================================
 * Weekly Synthesis Scheduler - 핵심 공유 로직 (주차 계산 + 결정론적 추첨)
 * 이 파일은 index.html 에 그대로 인라인되며, Node 단위테스트에서도 사용됨
 * ===================================================================== */

const KST_OFFSET_MS = 9 * 3600 * 1000; // Asia/Seoul, DST 없음
const DAY_MS = 86400000;

/* ---- 슬롯 정의 (canonical order) ----
 * Day   : 월~목 09:00-18:00  → D0~D3
 * Night : 월~목 18:00-익일09 → N0~N3
 * Weekend: 금/토/일 전일     → W0~W2
 * 배치: 1~4  → cellKey = "D0-1" 형태 (총 44개)
 */
const SLOT_DEFS = [
  { key: 'D0', period: 'Day',     label: '월요일 09-18시',        day: '월' },
  { key: 'D1', period: 'Day',     label: '화요일 09-18시',        day: '화' },
  { key: 'D2', period: 'Day',     label: '수요일 09-18시',        day: '수' },
  { key: 'D3', period: 'Day',     label: '목요일 09-18시',        day: '목' },
  { key: 'N0', period: 'Night',   label: '월요일 18시-화 09시',   day: '월' },
  { key: 'N1', period: 'Night',   label: '화요일 18시-수 09시',   day: '화' },
  { key: 'N2', period: 'Night',   label: '수요일 18시-목 09시',   day: '수' },
  { key: 'N3', period: 'Night',   label: '목요일 18시-금 09시',   day: '목' },
  { key: 'W0', period: 'Weekend', label: '금요일 (전일)',          day: '금' },
  { key: 'W1', period: 'Weekend', label: '토요일 (전일)',          day: '토' },
  { key: 'W2', period: 'Weekend', label: '일요일 (전일)',          day: '일' },
];
const SLOT_ORDER = SLOT_DEFS.map(s => s.key);
const BATCHES = [1, 2, 3, 4];
const ALL_CELL_KEYS = SLOT_ORDER.flatMap(s => BATCHES.map(b => `${s}-${b}`));
const TOKENS_PER_WEEK = 4;
const DAY_CAP = 2; // 1주 Day 시간대 1인 최대 배치 수

function isDaySlot(slotKey) { return slotKey[0] === 'D'; }
function parseCell(cellKey) {
  const [slot, b] = cellKey.split('-');
  return { slot, batch: parseInt(b, 10) };
}

/* ---- 주차 계산 (월요일 시작, KST 고정) ---- */
function kstDayNum(ms) { return Math.floor((ms + KST_OFFSET_MS) / DAY_MS); }
function kstDow(ms) { return (kstDayNum(ms) + 3) % 7; } // 0=월 ... 6=일 (1970-01-01=목 검증됨)
function weekIndexOf(ms) { const d = kstDayNum(ms); return (d - ((d + 3) % 7)) / 7; }
function weekStartMs(weekIdx) { return weekIdx * 7 * DAY_MS - KST_OFFSET_MS; } // 해당 주 월요일 00:00 KST의 UTC ms
function fmtDate(ms) {
  const d = new Date(ms + KST_OFFSET_MS);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}
function weekLabel(weekIdx) {
  const s = weekStartMs(weekIdx);
  return `${fmtDate(s)}(월) ~ ${fmtDate(s + 6 * DAY_MS)}(일)`;
}
/* 투표 주(현재 주)의 국면 판정. targetWeek = votingWeek + 1 */
function phaseOf(nowMs) {
  const votingWeek = weekIndexOf(nowMs);
  const targetWeek = votingWeek + 1;
  const monday = weekStartMs(votingWeek);
  const voteClose = monday + 3 * DAY_MS;            // 목요일 00:00 (= 수요일 24시)
  const announce = monday + 3 * DAY_MS + 12 * 3600 * 1000; // 목요일 12:00
  let phase;
  if (nowMs < voteClose) phase = 'VOTING';
  else if (nowMs < announce) phase = 'WAITING';
  else phase = 'BOOKING';
  return { votingWeek, targetWeek, monday, voteClose, announce, phase };
}

/* ---- 결정론적 시드 및 PRNG ---- */
/* 투표 스냅샷의 canonical JSON: memberId 정렬, 각 멤버의 cell 목록 정렬 */
function canonicalVotesJson(votesByMember) {
  const ids = Object.keys(votesByMember).sort();
  const obj = {};
  for (const id of ids) {
    obj[id] = [...votesByMember[id]].sort();
  }
  return JSON.stringify(obj);
}

/* SHA-256 (의존성 없는 순수 JS 구현; 브라우저/Node 동일 결과) */
function sha256Hex(str) {
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  let H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rr = (x, n) => (x >>> n) | (x << (32 - n));
  // UTF-8 인코딩
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.codePointAt(i);
    if (c > 0xffff) i++;
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push((i >= 4 ? 0 : (bitLen / Math.pow(2, i * 8))) & 0xff);
  // 상위 32비트는 실용상 0 (2^32비트 미만 입력)
  for (let off = 0; off < bytes.length; off += 64) {
    const w = new Array(64);
    for (let i = 0; i < 16; i++)
      w[i] = (bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16) | (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H = H.map((x, i) => (x + [a, b, c, d, e, f, g, h][i]) | 0);
  }
  return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/* mulberry32 - 시드 기반 결정론적 PRNG */
function makeRng(seedHex) {
  let s = parseInt(seedHex.slice(0, 8), 16) >>> 0;
  // 시드 확장: 해시 뒷부분도 섞음
  s = (s ^ parseInt(seedHex.slice(8, 16), 16)) >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* =====================================================================
 * 결정론적 추첨
 * 입력: votesByMember = { memberId: ["D0-1","D0-2","N1-3", ...] }
 * 출력: { seed, assignments: {cellKey: memberId}, priorityMembers: [...],
 *         dayCount: {memberId: n} }
 *
 * 규칙 구현:
 * (1) 동일 슬롯+배치 1인 배정, 경합 시 시드 기반 무작위 추첨
 * (2) Day 시간대 주간 1인 최대 2배치 (배정 시점 강제)
 * (3) 동일 슬롯에 2개 이상 배치 투표자(번들)가 우선권, 번들 간 경합도 무작위
 * (4) 번들은 all-or-nothing (전부 배정 또는 전부 탈락)
 * ===================================================================== */
function computeLottery(votesByMember) {
  const canonical = canonicalVotesJson(votesByMember);
  const seed = sha256Hex(canonical);
  const rng = makeRng(seed);

  const assignments = {}; // cellKey -> memberId
  const dayCount = {};    // memberId -> Day 배정 수
  const memberIds = Object.keys(votesByMember).sort();

  for (const slot of SLOT_ORDER) {
    const day = isDaySlot(slot);
    // 이 슬롯에서 멤버별 투표 배치 목록
    const bySlot = [];
    for (const m of memberIds) {
      const bs = (votesByMember[m] || [])
        .map(parseCell).filter(c => c.slot === slot).map(c => c.batch)
        .sort((a, b) => a - b);
      if (bs.length) bySlot.push({ m, bs });
    }
    // --- 1단계: 번들(같은 슬롯 2개 이상 배치) 우선, 무작위 순서 그리디 ---
    const bundles = shuffled(bySlot.filter(x => x.bs.length >= 2), rng);
    for (const { m, bs } of bundles) {
      if (day && (dayCount[m] || 0) + bs.length > DAY_CAP) continue; // 규칙(2)
      const free = bs.every(b => !assignments[`${slot}-${b}`]);
      if (free) { // 규칙(4): all-or-nothing
        for (const b of bs) assignments[`${slot}-${b}`] = m;
        if (day) dayCount[m] = (dayCount[m] || 0) + bs.length;
      }
    }
    // --- 2단계: 단일 투표자, 배치별 무작위 추첨 ---
    const singles = bySlot.filter(x => x.bs.length === 1);
    for (const b of BATCHES) {
      const key = `${slot}-${b}`;
      if (assignments[key]) continue;
      const cands = singles
        .filter(x => x.bs[0] === b)
        .filter(x => !(day && (dayCount[x.m] || 0) >= DAY_CAP))
        .map(x => x.m); // memberIds 순회로 이미 정렬됨
      if (!cands.length) continue;
      const pick = cands.length === 1 ? cands[0] : cands[Math.floor(rng() * cands.length)];
      assignments[key] = pick;
      if (day) dayCount[pick] = (dayCount[pick] || 0) + 1;
    }
  }

  // Day에 1표 이상 투자했으나 Day 배정 0인 인원 → 우선예약 대상
  const priorityMembers = memberIds.filter(m => {
    const votedDay = (votesByMember[m] || []).some(c => isDaySlot(parseCell(c).slot));
    return votedDay && !(dayCount[m] > 0);
  });

  return { seed, assignments, priorityMembers, dayCount, canonical };
}

/* 투표 유효성 검사 (클라이언트 측; 서버 rules 와 동일 기준) */
function validateVoteSet(cells) {
  if (!Array.isArray(cells)) return '형식 오류';
  if (cells.length > TOKENS_PER_WEEK) return `토큰은 주당 ${TOKENS_PER_WEEK}개까지입니다.`;
  const set = new Set(cells);
  if (set.size !== cells.length) return '동일 슬롯·배치에 중복 투표할 수 없습니다.';
  for (const c of cells) if (!ALL_CELL_KEYS.includes(c)) return `유효하지 않은 슬롯: ${c}`;
  // 단일 Day 슬롯 내 3개 이상 번들은 규칙(2)와 (4)의 조합상 절대 당첨 불가 → 사전 차단
  for (const s of SLOT_ORDER.filter(isDaySlot)) {
    const n = cells.filter(c => parseCell(c).slot === s).length;
    if (n > DAY_CAP) return `Day 슬롯(${s}) 하나에 ${n}개 배치 묶음은 Day 주간 2개 제한과 전부-또는-전무 규칙상 당첨이 불가능하여 차단됩니다.`;
  }
  return null;
}

/* Node 테스트용 export (브라우저에서는 무시됨) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SLOT_DEFS, SLOT_ORDER, BATCHES, ALL_CELL_KEYS, TOKENS_PER_WEEK, DAY_CAP,
    isDaySlot, parseCell, kstDayNum, kstDow, weekIndexOf, weekStartMs, weekLabel, phaseOf,
    canonicalVotesJson, sha256Hex, makeRng, shuffled, computeLottery, validateVoteSet, fmtDate,
  };
}
/* =====================================================================
 * Weekly Synthesis Scheduler - Slack 발표 봇
 * 매주 목요일 12시에 실행되어:
 *  1) 추첨 결과가 아직 없으면 (동일한 결정론적 알고리즘으로) 확정·게시
 *  2) 확정 스케줄을 Slack 공지용 메시지로 출력 (stdout)
 *
 * 사용법:  node scheduler_bot.js          → 실제 Firestore 조회
 *          node scheduler_bot.js --mock   → 가상 데이터로 메시지 형식 미리보기
 * ===================================================================== */

/* ★★★ [필수 설정] index.html에 넣은 것과 동일한 값 ★★★ */
const BOT_CONFIG = {
  apiKey: "AIzaSyASUCqicjGLh7P86OA2ZLc-8gidrZnRCpI",          // FIREBASE_CONFIG.apiKey 와 동일
  projectId: "inno-synthesis-scheduler",       // FIREBASE_CONFIG.projectId 와 동일
  appUrl: "https://innokaist.github.io/INNO-Synthesis-Scheduler/",          // 배포된 스케줄러 주소 (예: https://아이디.github.io/scheduler/)
};

const MOCK = process.argv.includes('--mock');

/* ---------------- Firestore REST 헬퍼 ---------------- */
const FS_BASE = () => `https://firestore.googleapis.com/v1/projects/${BOT_CONFIG.projectId}/databases/(default)/documents`;

async function anonToken() {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${BOT_CONFIG.apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const j = await r.json();
  if (!j.idToken) throw new Error('익명 인증 실패: ' + JSON.stringify(j).slice(0, 200) + ' (Firebase 콘솔에서 익명 로그인 활성화 확인)');
  return j.idToken;
}

/* Firestore Value <-> JS 변환 (이 앱에서 쓰는 타입만) */
function fromFs(v) {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue !== undefined) return null;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(fromFs);
  if (v.mapValue !== undefined) return decodeFields(v.mapValue.fields || {});
  return null;
}
function decodeFields(fields) {
  const o = {};
  for (const [k, v] of Object.entries(fields)) o[k] = fromFs(v);
  return o;
}
function toFs(x) {
  if (x === null) return { nullValue: null };
  if (typeof x === 'string') return { stringValue: x };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (typeof x === 'number') return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(toFs) } };
  if (typeof x === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(x)) fields[k] = toFs(v);
    return { mapValue: { fields } };
  }
  throw new Error('encode 불가: ' + typeof x);
}
function encodeFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFs(v);
  return fields;
}

async function fsGet(token, path) {
  const r = await fetch(`${FS_BASE()}/${path}`, { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 404) return null;
  const j = await r.json();
  if (j.error) throw new Error(`GET ${path}: ${j.error.message}`);
  return decodeFields(j.fields || {});
}
async function fsList(token, collection) {
  let docs = [], pageToken = '';
  do {
    const r = await fetch(`${FS_BASE()}/${collection}?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`,
      { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json();
    if (j.error) throw new Error(`LIST ${collection}: ${j.error.message}`);
    for (const d of j.documents || []) docs.push({ id: d.name.split('/').pop(), ...decodeFields(d.fields || {}) });
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return docs;
}
async function fsQueryByWeek(token, collection, week) {
  const r = await fetch(`${FS_BASE().replace(/\/documents$/, '/documents')}:runQuery`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: collection }],
      where: { fieldFilter: { field: { fieldPath: 'week' }, op: 'EQUAL', value: { integerValue: String(week) } } },
    } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`QUERY ${collection}: ${j.error.message}`);
  return (Array.isArray(j) ? j : []).filter(x => x.document)
    .map(x => ({ id: x.document.name.split('/').pop(), ...decodeFields(x.document.fields || {}) }));
}
async function fsCreate(token, collection, docId, obj) {
  const r = await fetch(`${FS_BASE()}/${collection}?documentId=${encodeURIComponent(docId)}`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: encodeFields(obj) }),
  });
  const j = await r.json();
  if (j.error) {
    if (j.error.status === 'ALREADY_EXISTS' || j.error.code === 409) return false; // 다른 곳에서 이미 생성됨 (정상)
    throw new Error(`CREATE ${collection}/${docId}: ${j.error.message}`);
  }
  return true;
}

/* ---------------- 메시지 구성 ---------------- */
function buildMessage({ targetWeek, results, bookings, members, config }) {
  const nameOf = id => members[id]?.name || '(알 수 없음)';
  const label = weekLabel(targetWeek);
  const a = results.assignments || {};
  const lines = [];
  lines.push(`📢 *합성 스케줄 확정 발표 — ${label}*`);
  lines.push('');

  // 슬롯 순서대로 정렬된 배정 목록
  const byPeriod = { Day: [], Night: [], Weekend: [] };
  for (const sd of SLOT_DEFS) {
    for (const b of BATCHES) {
      const key = `${sd.key}-${b}`;
      if (a[key]) byPeriod[sd.period].push(`  • ${sd.label} · Batch #${b} — *${nameOf(a[key])}*`);
      else if (bookings[key]) byPeriod[sd.period].push(`  • ${sd.label} · Batch #${b} — *${nameOf(bookings[key].memberId)}* (예약)`);
    }
  }
  const nAssigned = Object.keys(a).length;
  const nBooked = Object.keys(bookings).length;
  lines.push(`🎲 *추첨 확정: ${nAssigned}건*${nBooked ? ` / 예약: ${nBooked}건` : ''}`);
  for (const p of ['Day', 'Night', 'Weekend']) {
    if (byPeriod[p].length) {
      lines.push(`*[${p}]*`);
      lines.push(...byPeriod[p]);
    }
  }
  if (!nAssigned && !nBooked) lines.push('_이번 주 배정 없음 (투표 없음)_');
  lines.push('');

  const prio = results.priorityMembers || [];
  const prioMin = config?.priorityWindowMin ?? 60;
  if (prio.length && prioMin > 0) {
    lines.push(`🎗 *Day 우선예약 대상* (Day 지원했으나 미선정): ${prio.map(nameOf).join(', ')}`);
    lines.push(`   → 지금부터 *${prioMin}분간* 위 인원만 빈 슬롯 선착순 예약 가능, 이후 전체 오픈`);
  } else {
    lines.push(`⚡ 빈 슬롯 선착순 예약이 *지금부터* 전체 오픈되었습니다 (1인 횟수 제한 없음)`);
  }
  const empty = 44 - nAssigned - nBooked;
  lines.push(`▫ 남은 빈 슬롯: *${empty}칸*`);
  if (BOT_CONFIG.appUrl) {
    lines.push('');
    lines.push(`👉 예약 바로가기: ${BOT_CONFIG.appUrl}`);
  }
  lines.push(`_추첨 시드(투표 데이터 해시): ${String(results.seed || '').slice(0, 16)}… — 앱 '추첨 결과' 탭에서 누구나 검증 가능_`);
  return lines.join('\n');
}

/* ---------------- 메인 ---------------- */
async function main() {
  if (MOCK) {
    const votes = {
      alice: ['D0-1', 'D0-2', 'N1-1'], bob: ['D0-1', 'W1-2'], carol: ['D1-3', 'D2-3', 'N2-2'],
      dave: ['D0-1', 'N1-1', 'W2-4'], erin: ['D1-3', 'W0-1', 'W1-2', 'N3-4'],
    };
    const r = computeLottery(votes);
    const members = Object.fromEntries(Object.keys(votes).map(k => [k, { name: '(예시)' + k }]));
    const c = phaseOf(Date.now());
    console.log(buildMessage({ targetWeek: c.targetWeek, results: { ...r, priorityMembers: r.priorityMembers }, bookings: {}, members, config: { priorityWindowMin: 60 } }));
    return;
  }

  if (!BOT_CONFIG.apiKey || !BOT_CONFIG.projectId) {
    console.error('BOT_CONFIG에 apiKey/projectId를 입력하세요.');
    process.exit(2);
  }

  const nowMs = Date.now();
  const c = phaseOf(nowMs);
  if (nowMs < c.announce) {
    console.error(`아직 발표 시각(목 12:00 KST) 전입니다. 발표까지 ${Math.round((c.announce - nowMs) / 60000)}분.`);
    process.exit(3);
  }

  const token = await anonToken();

  // 1) 결과 확인, 없으면 결정론적으로 계산해 생성
  let results = await fsGet(token, `results/${c.targetWeek}`);
  if (!results) {
    const voteDocs = await fsQueryByWeek(token, 'votes', c.targetWeek);
    const votesByMember = {};
    for (const d of voteDocs) votesByMember[d.memberId] = Object.keys(d.cells || {}).sort();
    const r = computeLottery(votesByMember);
    const doc = {
      week: c.targetWeek, seed: r.seed, assignments: r.assignments,
      priorityMembers: r.priorityMembers, votesJson: r.canonical, createdBy: 'slack-bot',
    };
    await fsCreate(token, 'results', String(c.targetWeek), doc);
    results = await fsGet(token, `results/${c.targetWeek}`); // 경합 시 실제 저장본 사용
  }

  // 2) 부가 데이터
  const memberDocs = await fsList(token, 'members');
  const members = Object.fromEntries(memberDocs.map(m => [m.id, m]));
  const bookingDocs = await fsQueryByWeek(token, 'bookings', c.targetWeek);
  const bookings = Object.fromEntries(bookingDocs.map(b => [b.cellKey, b]));
  const config = await fsGet(token, 'config/app');

  // 3) 메시지 출력
  console.log(buildMessage({ targetWeek: c.targetWeek, results, bookings, members, config }));
}

main().catch(e => { console.error('봇 실행 오류:', e.message); process.exit(1); });
