// ============================================================
// Global AdTech & Agency Deal Tracker  v11.12
// M&A · 지분투자 · 파트너십 수집 → Gemini 정제 → 웹 대시보드
// ============================================================
//
// v10.x(구글시트 단독)와의 구조적 차이:
//
//   [수집] RSS (제목 + description 스니펫까지 확보)
//     ↓
//   [프리필터] 느슨한 정규식 — 딜/투자/제휴 동사가 있으면 통과
//     (재현율 담당. "무조건 긁어온다"가 목표이므로 공격적 차단 계층 제거)
//     ↓
//   [Gemini 일괄 정제] 판정 + 번역 + 필드 추출을 JSON 한 번에
//     - 관련 없으면 그 자리에서 탈락 (시트에 아예 안 들어감)
//     - 시트 =AI() 수식/청소부(L열) 완전 제거
//     - fail-closed: Gemini 못 쓰면 그 배치는 적재 보류
//     ↓
//   [딜DB 시트] = 데이터베이스
//     ↓
//   [doGet 웹앱] = 대시보드 (index.html)
//
// ── 최초 설정 순서 ──────────────────────────────────────────
//   1. saveGeminiKey()  실행 → API 키 저장
//   2. testGeminiKey()  실행 → "✅ API 정상" 확인
//   3. collectDeals()   실행 → 첫 수집
//   4. setDailyTrigger() 실행 → 매일 오전 9시 자동 수집 + 3시간마다 watchdog(실패 시 재수집·중복 정리·트리거 복구)
//   5. 배포 → 새 배포 → 웹 앱 (액세스: 링크가 있는 모든 사용자)
//      → 발급된 URL이 대시보드 주소
// ============================================================


// ── 전역 설정 ────────────────────────────────────────────────
var SHEET_NAME         = "딜DB";
var HISTORY_LOOKBACK   = 600;
var MAX_ITEMS_PER_FEED = 50;
var FETCH_BATCH_SIZE   = 12;
var BATCH_SLEEP_MS     = 300;
var MAX_RUNTIME_MS     = 5 * 60 * 1000;

var TIME_WINDOW  = "when:30d";
var MAX_AGE_DAYS = 32;

var GEMINI_MODEL  = "gemini-flash-latest";   // 최신 Flash 자동 추적 별칭 (구모델 은퇴에 영향받지 않음)
// 503(과부하)/429(쿼터) 시 순서대로 폴백. 별칭이 가리키는 최신 모델이 과부하일 때 고정 버전으로 우회한다.
var GEMINI_MODELS = [GEMINI_MODEL, "gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-flash-lite-latest"];
var GEMINI_RETRY_WAITS_MS = [3000, 8000];   // 같은 모델에서 503/429 재시도 간격 (모델당 최대 3회 호출)
var EXTRACT_CHUNK = 15;      // Gemini 1회 호출당 기사 수 (필드 추출까지 하므로 소량)

var DEAL_COLS = 13;          // A~M

var LAST_GEMINI_ERROR = "";  // 원격 진단용: 마지막 Gemini 실패 사유

// v11.11 — 운영 안정화
var REVIEW_SHEET     = "심사이력";   // Gemini가 무관/동일딜로 판정한 기사 링크. 다음 실행부터 재심사하지 않는다 (판정 흔들림·토큰 낭비 차단)
var REVIEW_KEEP_ROWS = 6000;         // 심사이력 최대 보관 행 (초과분은 오래된 것부터 삭제. 32일 지난 기사는 어차피 프리필터에서 탈락)
var RUNLOG_SHEET     = "실행로그";   // 매 실행의 통계·오류. Apps Script 로그 없이도 원인 추적 가능
var RUNLOG_KEEP_ROWS = 400;
var GEMINI_CHUNK_BUDGET_MS = 90 * 1000;  // 청크 1개에 허용하는 Gemini 총 시간 (재시도·폴백 포함). 6분 하드리밋 보호
var LOCK_WAIT_MS     = 10 * 1000;        // 트리거와 수동 실행이 겹칠 때 대기 시간. 못 잡으면 이번 실행은 건너뜀

// v11.12 — 무인 운영 (사람이 매일 들어오지 않아도 스스로 복구)
var WATCHDOG_EVERY_HOURS = 3;   // 감시 트리거 주기
var STALE_RUN_HOURS      = 22;  // 마지막 실행이 이보다 오래됐으면(트리거 소실·실패 등) 감시 트리거가 대신 수집
var RETRY_AFTER_HOURS    = 1;   // 마지막 실행이 오류/Gemini 실패/타임아웃이면 이만큼 지난 뒤 재수집

// 원격 관리(?run=...) 호출용 비밀 토큰.
// 소스를 공개 저장소에 올리므로 코드에 두지 않고 스크립트 속성에서 읽는다.
// 최초 1회 saveAdminToken() 실행 필요. 미설정이면 원격 관리 동작은 전부 거부된다.
function adminToken_() {
  var stored = PropertiesService.getScriptProperties().getProperty("ADMIN_TOKEN");
  if (stored) return stored;
  // secrets.js (gitignore 대상, clasp 로만 배포됨) 의 값을 폴백으로 쓴다
  return (typeof LOCAL_ADMIN_TOKEN !== "undefined") ? LOCAL_ADMIN_TOKEN : "";
}


// ── 지역 에디션 ──────────────────────────────────────────────
var EDITIONS = {
  US:    "hl=en-US&gl=US&ceid=US:en",
  GB:    "hl=en-GB&gl=GB&ceid=GB:en",
  IN:    "hl=en-IN&gl=IN&ceid=IN:en",
  SG:    "hl=en-SG&gl=SG&ceid=SG:en",
  JP_EN: "hl=en-US&gl=JP&ceid=JP:en",
  JP_JA: "hl=ja&gl=JP&ceid=JP:ja"
};

// 검색 OR 구문 — M&A + 지분투자 + 파트너십
var DEAL_OR_RUN =
  'acquisition OR acquires OR merger OR buyout OR "stake in" OR ' +
  '"invests in" OR investment OR partnership OR "joint venture" OR "teams up"';
var DEAL_OR_RUN_JA =
  '買収 OR 子会社化 OR 株式取得 OR 経営統合 OR 資本提携 OR 業務提携 OR 出資';


// ============================================================
// 프리필터 정규식 — 느슨하게. 최종 결정은 Gemini가 한다.
// ============================================================
var DEAL_HINTS_EN = [
  // M&A
  /\bacqui(res?|red|ring|sition)\b/i, /\bto acquire\b/i,
  /\bbuy-?outs?\b/i, /\btakeovers?\b/i, /\btakes? over\b/i,
  /\bmergers?\b/i, /\bmerges?\b/i, /\bmerged\b/i,
  /\bbuys\b/i, /\bbought\b/i, /\bto buy\b/i, /\bwill buy\b/i,
  /\bsnaps? up\b/i, /\bsnapped up\b/i,
  /\bsubsidiary\b/i,
  /\bdivests?\b/i, /\bdivestitures?\b/i,
  /\bsells (its|off|majority|minority|stake|unit|division|business|arm)\b/i,
  /\bacqui-?hire[sd]?\b/i,
  // 지분투자
  /\bstakes?\b/i, /\binvests? in\b/i, /\binvestment in\b/i,
  /\b(strategic|minority|equity) investment\b/i,
  /\bcapital (injection|infusion|participation)\b/i,
  /\bbacks\b/i, /\bbacked by\b/i, /\bfunding\b/i,
  // 파트너십
  /\bpartners? with\b/i, /\bpartnership\b/i,
  /\bjoint venture\b/i, /\bjv\b/i,
  /\bteams? up\b/i, /\ballianc(e|es)\b/i,
  /\btie-?up\b/i, /\bcollaborat(es?|ion) with\b/i
];

var DEAL_HINTS_JA = [
  /買収/, /子会社化/, /完全子会社/, /株式取得/, /株式譲渡/,
  /経営統合/, /事業譲渡/, /TOB/, /傘下に/, /持分譲渡/,
  /資本参加/, /資本提携/, /業務提携/, /資本業務提携/, /出資/, /合弁/
];

// 명백한 쓰레기만 싸게 걸러 Gemini 토큰을 아낀다 (정밀 차단은 Gemini 몫)
var HARD_BLOCK = [
  /\btagged\b/i, /\ball posts\b/i, /\barchives?\b/i, /\bcategory:/i, /\btag:/i,
  /\b(customer|consumer|user|talent|player|patient) acquisitions?\b/i,
  /\bcost per acquisition\b/i, /\bcac\b/i,
  /\b(broadcast|streaming|telecast) rights\b/i,
  /\bpop-?ups?\b/i,
  /顧客獲得/, /ポップアップ/, /放映権/, /配信権/
];

var AD_DOMAIN_PATTERNS = [
  /\bad-?tech\b/i, /\bmar-?tech\b/i,
  /\badvertis(ing|ement|ements|er|ers)\b/i,
  /\bagenc(y|ies)\b/i,
  /\bmarketing\b/i, /\bbrand(ing)?\b/i, /\bcreative\b/i,
  /\bretail media\b/i, /\bprogrammatic\b/i,
  /\b(dsp|ssp|cdp|dmp)s?\b/i, /\bctv\b/i, /\bconnected tv\b/i,
  /\bmedia (network|owner|holding|group|shop|agency)\b/i,
  /\binfluencer\b/i, /\bpublic relations\b/i, /\bpr (firm|agency)\b/i,
  /\b(wpp|omnicom|publicis|interpublic|ipg|dentsu|hakuhodo|havas|stagwell|brainlabs|monks|s4 capital|adk|groupm|ogilvy|mccann|bbdo|ddb|vml)\b/i,
  /広告/, /マーケティング/, /代理店/
];


// ── 감시 대상 ────────────────────────────────────────────────
var WATCH_ENTITIES = [
  { term: 'Hakuhodo', jaTerm: '博報堂', eds: ["US", "IN", "SG", "JP_JA"],
    anchors: [/\bhakuhodo\b/i, /博報堂/, /\badglobal\s?360\b/i] },
  { term: '"Hakuhodo DY"', jaTerm: '博報堂DYホールディングス', eds: ["JP_EN", "JP_JA"],
    anchors: [/\bhakuhodo\b/i, /博報堂/] },
  { term: 'AdGlobal360', eds: ["IN"],
    anchors: [/\badglobal\s?360\b/i, /\bhakuhodo\b/i] },
  { term: 'Dentsu', jaTerm: '電通', eds: ["US", "GB", "IN", "SG", "JP_JA"],
    anchors: [/\bdentsu\b/i, /電通/] },
  { term: 'ADK', jaTerm: 'ADKホールディングス', eds: ["JP_JA", "SG"],
    anchors: [/\badk\b/i, /ADK/, /アサツー/] },
  { term: '"Cyber Agent"', jaTerm: 'サイバーエージェント', eds: ["JP_JA"],
    anchors: [/\bcyberagent\b/i, /\bcyber agent\b/i, /サイバーエージェント/] },

  { term: 'WPP',            eds: ["US", "GB"], anchors: [/\bwpp\b/i, /\bgroupm\b/i, /\bogilvy\b/i, /\bvml\b/i] },
  { term: 'Omnicom',        eds: ["US"],       anchors: [/\bomnicom\b/i, /\bomd\b/i, /\bbbdo\b/i, /\bddb\b/i] },
  { term: 'Publicis',       eds: ["US", "GB"], anchors: [/\bpublicis\b/i, /\bsapient\b/i, /\bleo burnett\b/i] },
  { term: 'Interpublic',    eds: ["US"],       anchors: [/\binterpublic\b/i, /\bipg\b/i, /\bmccann\b/i, /\bmediabrands\b/i] },
  { term: 'Havas',          eds: ["US", "GB"], anchors: [/\bhavas\b/i] },
  { term: 'Stagwell',       eds: ["US"],       anchors: [/\bstagwell\b/i] },
  { term: '"S4 Capital"',   eds: ["GB", "US"], anchors: [/\bs4 capital\b/i, /\bmonks\b/i] },
  { term: 'Brainlabs',      eds: ["GB"],       anchors: [/\bbrainlabs\b/i] },
  { term: '"Accenture Song"', eds: ["US"],     anchors: [/\baccenture song\b/i, /\baccenture\b/i] },

  { term: 'adtech',               eds: ["US", "GB"], anchors: AD_DOMAIN_PATTERNS },
  { term: 'martech',              eds: ["US"],       anchors: AD_DOMAIN_PATTERNS },
  { term: '"retail media"',       eds: ["US", "GB"], anchors: AD_DOMAIN_PATTERNS },
  { term: '"advertising agency"', eds: ["US", "GB"], anchors: AD_DOMAIN_PATTERNS },
  { term: '"media agency"',       eds: ["US", "GB"], anchors: AD_DOMAIN_PATTERNS },
  { term: '"creative agency"',    eds: ["US", "GB"], anchors: AD_DOMAIN_PATTERNS },
  { term: '"digital agency"',     eds: ["IN", "SG"], anchors: AD_DOMAIN_PATTERNS },
  { term: '"marketing agency"',   eds: ["US", "IN"], anchors: AD_DOMAIN_PATTERNS }
];

var SOURCE_FEEDS = [
  { site: 'exchange4media.com',        eds: ["IN"] },
  { site: 'pitchonnet.com',            eds: ["IN"] },
  { site: 'indiantelevision.com',      eds: ["IN"] },
  { site: 'campaignindia.in',          eds: ["IN"] },
  { site: 'afaqs.com',                 eds: ["IN"] },
  { site: 'campaignasia.com',          eds: ["SG"] },
  { site: 'marketing-interactive.com', eds: ["SG"] },
  { site: 'adage.com',                 eds: ["US"] },
  { site: 'adweek.com',                eds: ["US"] },
  { site: 'digiday.com',               eds: ["US"] },
  { site: 'thedrum.com',               eds: ["GB"] },
  { site: 'campaignlive.co.uk',        eds: ["GB"] }
];


// ── 중복 판별용 지문 사전 ────────────────────────────────────
var GENERIC_TOKENS = {};
[
  "acquire","acquires","acquired","acquisition","acquisitions","merge","merges","merger","merged",
  "buyout","takeover","takes","take","over","stake","stakes","majority","minority","deal","deals",
  "buys","buy","bought","purchase","purchases","invest","invests","invested","investment",
  "partner","partners","partnership","partnerships","alliance","venture","joint","teams","team",
  "agency","agencies","group","groups","holding","holdings","company","companies","firm","firms",
  "digital","marketing","media","advertising","adtech","martech","tech","technology","technologies",
  "solution","solutions","service","services","business","businesses","platform","platforms",
  "global","international","worldwide","market","markets","network","networks",
  "announce","announces","announced","complete","completes","completed","close","closes","closed",
  "expand","expands","expansion","strengthen","strengthens","boost","boosts","grow","grows","growth",
  "launch","launches","report","reports","exclusive","news","update","updates","says","said",
  "with","from","into","that","this","will","have","has","been","its","their","after","amid","through",
  "new","first","major","leading","independent","integrated","creative","content","data","brand","brands",
  "capabilities","capability","offering","portfolio","presence","operations","unit","division","arm",
  "million","billion","undisclosed","reportedly","near","nears","set","plans","plan","move","moves",
  "india","indian","japan","japanese","private","limited","inc","ltd","llc","pvt"
].forEach(function (w) { GENERIC_TOKENS[w] = true; });

var COMPANY_ALIASES = [
  [/hakuhodo dy (holdings|one|media partners)/g, "hakuhodo"],
  [/hakuhodo international/g,                    "hakuhodo"],
  [/interpublic group/g,                         "interpublic"],
  [/\bipg\b/g,                                   "interpublic"],
  [/publicis groupe/g,                           "publicis"],
  [/omnicom group/g,                             "omnicom"],
  [/dentsu (inc|group|international)/g,          "dentsu"],
  [/wpp plc/g,                                   "wpp"],
  [/adglobal 360/g,                              "adglobal360"]
];


// ============================================================
// Gemini API 키 관리
// ============================================================
// 사용법: 아래 KEY 자리에 https://aistudio.google.com/apikey 에서 발급한
// 키를 붙여넣고 이 함수를 실행하세요. 저장이 확인되면
// 보안을 위해 KEY 값을 다시 "" 로 지우고 저장(Ctrl+S)하면 됩니다.
function saveGeminiKey() {
  var KEY = "";   // ← 여기에 키 붙여넣기

  if (!KEY.trim()) {
    Logger.log("❌ KEY 변수가 비어 있습니다. 코드의 KEY = \"\" 안에 키를 붙여넣고 다시 실행하세요.");
    return;
  }
  PropertiesService.getScriptProperties().setProperty("GEMINI_API_KEY", KEY.trim());
  Logger.log("✅ 키가 저장되었습니다. 이제 코드에서 KEY 값을 지워도 됩니다. 다음: setup() 실행");
}

// 원격 관리 토큰 저장. 사용법은 saveGeminiKey()와 같다:
// TOKEN 자리에 값을 붙여넣고 실행 → 저장 확인 후 다시 "" 로 비우고 Ctrl+S.
function saveAdminToken() {
  var TOKEN = "";   // ← 여기에 관리 토큰 붙여넣기

  if (!TOKEN.trim()) {
    Logger.log("❌ TOKEN 변수가 비어 있습니다. 코드의 TOKEN = \"\" 안에 값을 붙여넣고 다시 실행하세요.");
    return;
  }
  PropertiesService.getScriptProperties().setProperty("ADMIN_TOKEN", TOKEN.trim());
  Logger.log("✅ 관리 토큰이 저장되었습니다. 이제 코드에서 TOKEN 값을 지워도 됩니다.");
}

function testGeminiKey() {
  var out = extractBatchWithGemini_([
    { headline: "WPP acquires data consultancy InfoSum", desc: "" }
  ]);
  if (out === null) {
    Logger.log("❌ API 호출 실패. saveGeminiKey() 실행 여부와 위 로그의 오류 메시지를 확인하세요.");
  } else {
    Logger.log("✅ API 정상. 추출 결과: " + JSON.stringify(out[0]));
  }
}


// ============================================================
// 원클릭 초기 설정: 권한 승인 → 첫 수집 → 매일 트리거 등록
// (Gemini 키는 좌측 ⚙ 프로젝트 설정 → 스크립트 속성에
//  GEMINI_API_KEY 로 먼저 넣어두세요)
// ============================================================
function setup() {
  var key = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!key) {
    Logger.log("❌ GEMINI_API_KEY가 없습니다. 프로젝트 설정 → 스크립트 속성에 추가한 뒤 다시 실행하세요.");
    return;
  }
  collectDeals();
  setDailyTrigger();
  Logger.log("✅ 초기 설정 완료: 첫 수집 + 매일 9시 트리거 등록");
}


// ============================================================
// 트리거
// ============================================================
function setDailyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "collectDeals") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger("collectDeals").timeBased().everyDays(1).atHour(9).create();
  ensureTriggers_();
  toast_("매일 오전 9시 자동 수집 + 3시간 감시 트리거가 등록되었습니다.", "✅ Trigger Set");
}

/** 필요한 트리거가 빠져 있으면 만들어 넣는다 (있으면 손대지 않음). 수집 끝·watchdog·?run=setup 에서 호출. */
function ensureTriggers_() {
  var have = {};
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) have[triggers[i].getHandlerFunction()] = true;
  var created = [];
  if (!have["collectDeals"]) {
    ScriptApp.newTrigger("collectDeals").timeBased().everyDays(1).atHour(9).create();
    created.push("collectDeals");
  }
  if (!have["watchdog"]) {
    ScriptApp.newTrigger("watchdog").timeBased().everyHours(WATCHDOG_EVERY_HOURS).create();
    created.push("watchdog");
  }
  if (created.length) Logger.log("[TRIGGER] 복구: " + created.join(", "));
  return created;
}

/**
 * 감시 트리거 (3시간마다). 사람이 들어오지 않아도:
 *   - 트리거가 지워졌으면 다시 만든다
 *   - 마지막 실행이 22시간 넘게 없으면(9시 실행이 죽었거나 트리거 소실) 대신 수집한다
 *   - 마지막 실행이 오류/Gemini 실패/타임아웃이면 1시간 뒤부터 재수집한다 (보류된 청크 회수)
 * 수집 자체가 LockService 로 보호되므로 9시 실행과 겹쳐도 안전하다.
 */
function watchdog() {
  var created = ensureTriggers_();
  var last = lastRunLog_();
  var reason = "";
  if (!last) {
    reason = "실행 기록 없음";
  } else {
    var ageH = (new Date().getTime() - last.at.getTime()) / 3600000;
    var bad  = !!(last.error || last.geminiFailed || last.timedOut);
    if (ageH > STALE_RUN_HOURS)          reason = "마지막 실행 " + Math.round(ageH) + "시간 전";
    else if (bad && ageH > RETRY_AFTER_HOURS) reason = "직전 실행 실패/보류 재시도";
  }
  if (!reason) {
    Logger.log("[WATCHDOG] 정상 (트리거 복구 " + created.length + "건)");
    return { ok: true, ran: false, triggersCreated: created };
  }
  Logger.log("[WATCHDOG] 수집 실행 — " + reason);
  var stats = runPipeline_(false, "watchdog: " + reason);
  return { ok: true, ran: true, reason: reason, triggersCreated: created, stats: stats };
}


// ============================================================
// 이미 쌓인 중복 정리 (v11.0 이전에 적재된 행 대상)
// ============================================================
// 같은 딜(인수사·대상사 쌍이 같은 행)이 여러 건이면 가장 오래된 1건만 남긴다.
//   cleanupDuplicates()      → 삭제 대상만 로그로 출력 (시트 변경 없음)
//   cleanupDuplicates(true)  → 실제 삭제
function cleanupDuplicates(apply) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() <= 1) { Logger.log("시트가 비어 있습니다."); return 0; }

  var n = sheet.getLastRow() - 1;
  var values = sheet.getRange(2, 1, n, DEAL_COLS).getValues();

  // 최신순으로 쌓여 있으므로 아래(오래된 행)부터 훑어 원본을 남긴다
  var seen = {};
  var victims = [];
  for (var i = n - 1; i >= 0; i--) {
    var key = dealPairKey_(values[i][5], values[i][6]);   // F열 인수사, G열 대상기업
    if (!key) continue;
    if (seen[key]) victims.push(i + 2);                   // 시트 행번호
    else seen[key] = true;
  }

  Logger.log("전체 " + n + "행 │ 고유 딜 " + Object.keys(seen).length + "건 │ 중복 " + victims.length + "행");
  for (var v = 0; v < victims.length; v++) {
    Logger.log("  삭제 대상 " + victims[v] + "행 │ " + values[victims[v] - 2][3]);
  }

  if (!apply) { Logger.log("── DRY RUN. 실제로 지우려면 cleanupDuplicates(true) 실행 ──"); return victims.length; }

  victims.sort(function (a, b) { return b - a; });        // 아래쪽부터 지워야 행번호가 안 밀린다
  for (var k = 0; k < victims.length; k++) sheet.deleteRow(victims[k]);
  toast_(victims.length + "개 중복 행을 삭제했습니다.", "🧹 Cleanup");
  Logger.log("✅ " + victims.length + "행 삭제 완료");
  return victims.length;
}


// ============================================================
// 웹앱 (대시보드)
// ============================================================
function doGet(e) {
  // 독립 HTML(dashboard.html)용 JSON API: 배포URL?format=json
  if (e && e.parameter && e.parameter.format === "json") {
    return ContentService.createTextOutput(JSON.stringify(getDeals()))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 원격 관리: ?run=status | collect | setup | cleanup (&token=<스크립트 속성 ADMIN_TOKEN> 필수)
  // 대시보드가 공개 웹에 올라가면 배포 URL이 노출되므로,
  // 데이터 조회(format=json)는 열어두되 관리 동작에는 토큰을 요구한다.
  if (e && e.parameter && e.parameter.run) {
    var adminToken = adminToken_();
    if (!adminToken || e.parameter.token !== adminToken) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "unauthorized" }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    var out = { ok: false, action: e.parameter.run };
    try {
      var props = PropertiesService.getScriptProperties();
      if (e.parameter.run === "status") {
        out.ok = true;
        out.hasKey = !!props.getProperty("GEMINI_API_KEY");
        out.triggers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
        var ss0 = SpreadsheetApp.getActiveSpreadsheet();
        var sh = ss0.getSheetByName(SHEET_NAME);
        out.rows = sh ? Math.max(0, sh.getLastRow() - 1) : 0;
        var rv = ss0.getSheetByName(REVIEW_SHEET);
        out.reviewed = rv ? Math.max(0, rv.getLastRow() - 1) : 0;
        out.recentRuns = recentRunLogs_(ss0, 5);
      } else if (e.parameter.run === "collect") {
        out.stats = runPipeline_(false, "web");
        out.geminiError = LAST_GEMINI_ERROR;
        out.ok = true;
      } else if (e.parameter.run === "setup") {
        out.hasKey = !!props.getProperty("GEMINI_API_KEY");
        if (out.hasKey) { out.stats = runPipeline_(false, "web-setup"); setDailyTrigger(); out.geminiError = LAST_GEMINI_ERROR; out.ok = true; }
        else out.error = "GEMINI_API_KEY 미설정";
      } else if (e.parameter.run === "ensure") {
        // 트리거 점검·복구만 (수집 안 함)
        out.created = ensureTriggers_();
        out.triggers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
        out.ok = true;
      } else if (e.parameter.run === "watchdog") {
        out.result = watchdog();
        out.geminiError = LAST_GEMINI_ERROR;
        out.ok = true;
      } else if (e.parameter.run === "cleanup") {
        // ?run=cleanup           → 삭제 대상만 계산 (시트 변경 없음)
        // ?run=cleanup&apply=1   → 실제 삭제
        out.applied = (e.parameter.apply === "1");
        out.duplicates = cleanupDuplicates(out.applied);
        out.ok = true;
      } else if (e.parameter.run === "models") {
        var mkey = props.getProperty("GEMINI_API_KEY");
        var mres = UrlFetchApp.fetch(
          "https://generativelanguage.googleapis.com/v1beta/models?pageSize=50&key=" + encodeURIComponent(mkey),
          { muteHttpExceptions: true });
        if (mres.getResponseCode() === 200) {
          var mbody = JSON.parse(mres.getContentText());
          out.ok = true;
          out.models = (mbody.models || [])
            .filter(function (m) { return (m.supportedGenerationMethods || []).indexOf("generateContent") !== -1; })
            .map(function (m) { return m.name; });
        } else {
          out.error = "HTTP " + mres.getResponseCode() + " " + mres.getContentText().substring(0, 200);
        }
      } else if (e.parameter.run === "test") {
        var t = extractBatchWithGemini_([{ headline: "WPP acquires data consultancy InfoSum", desc: "" }]);
        out.ok = (t !== null);
        out.result = t;
        out.geminiError = LAST_GEMINI_ERROR;
      }
    } catch (err) {
      out.error = String(err);
    }
    return ContentService.createTextOutput(JSON.stringify(out))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return HtmlService.createHtmlOutputFromFile("index")
    .setTitle("광고업계 딜 트래커")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** 프론트엔드가 호출. 시트 → JSON 배열 */
function getDeals() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  var rows = Math.min(sheet.getLastRow() - 1, 1000);
  var values = sheet.getRange(2, 1, rows, DEAL_COLS).getDisplayValues();

  return values.map(function (r) {
    return {
      collected: r[0],  date: r[1],   type: r[2],
      titleEn: r[3],    titleKo: r[4],
      acquirer: r[5],   target: r[6], price: r[7],
      region: r[8],     domain: r[9], summary: r[10],
      link: r[11],      source: r[12]
    };
  });
}


// ============================================================
// 메인 파이프라인
// ============================================================
function collectDeals() { return runPipeline_(false, "collect"); }
function dryRun()       { return runPipeline_(true,  "dry-run"); }

/**
 * 진입점. 동시 실행 방지(LockService) + 실행로그 기록을 담당하고 실제 작업은 runPipelineLocked_ 에 위임.
 * 트리거(atHour(9)는 09:00~09:59 사이 임의 시각)와 수동 실행이 겹치면 같은 딜이 두 번 적재되던 문제를 막는다.
 */
function runPipeline_(isDryRun, mode) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    Logger.log("[LOCK] 다른 수집이 실행 중 — 이번 실행은 건너뜀");
    toast_("다른 수집이 실행 중입니다. 잠시 후 다시 시도하세요.", "⏳ Busy");
    return { skipped: true, reason: "locked" };
  }

  var startedAt = new Date().getTime();
  var stats = { fetched: 0, candidates: 0, skippedReviewed: 0, reviewed: 0, loaded: 0,
                pairDropped: 0, geminiFailed: false, timedOut: false, cleaned: 0 };
  var error = "";
  try {
    runPipelineLocked_(isDryRun, startedAt, stats);
  } catch (e) {
    error = String(e && e.stack ? e.stack : e);
    Logger.log("[PIPELINE FAIL] " + error);
    throw e;
  } finally {
    try { writeRunLog_(mode || "", startedAt, stats, error); } catch (e2) { Logger.log("[RUNLOG FAIL] " + e2); }
    lock.releaseLock();
  }
  return stats;
}

function runPipelineLocked_(isDryRun, startedAt, stats) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  ensureHeader_(sheet);

  // ── 1. 과거 데이터 (중복 방지) ──
  var historyTitles = [];
  var historyPrints = [];
  var historyPairs  = {};
  var historyLinks  = {};
  if (sheet.getLastRow() > 1) {
    var rowCount = Math.min(sheet.getLastRow() - 1, HISTORY_LOOKBACK);
    // D~L열: 제목(EN), 제목(KO), 인수·투자기업, 대상기업, ..., 링크
    var pastValues = sheet.getRange(2, 4, rowCount, 9).getValues();
    for (var h = 0; h < pastValues.length; h++) {
      var pastTitle = String(pastValues[h][0] || "").trim();
      if (pastTitle) {
        historyTitles.push(pastTitle.toLowerCase());
        historyPrints.push(dealFingerprint_(pastTitle));
      }
      var pastPair = dealPairKey_(pastValues[h][2], pastValues[h][3]);
      if (pastPair) historyPairs[pastPair] = true;
      var pastLink = String(pastValues[h][8] || "").trim();
      if (pastLink) historyLinks[pastLink] = true;
    }
  }
  // 이미 Gemini가 판정한 기사(무관/동일딜)는 다시 묻지 않는다
  var reviewedLinks = loadReviewedLinks_(ss);

  // ── 2. 수집 ──
  var items = fetchAllFeeds_(startedAt);
  stats.fetched = items.length;
  Logger.log("[수집] " + items.length + "건");
  if (items.length === 0) {
    toast_("RSS 응답이 비어 있습니다.", "⚠️ No Feed Data");
    return stats;
  }
  items.sort(function (a, b) { return parseDate_(b.pubDate) - parseDate_(a.pubDate); });

  // ── 3. 프리필터 + 중복 제거 ──
  var cutoff = new Date().getTime() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  var seenTitles = {};
  var seenLinks  = {};
  var batchPrints = [];
  var candidates  = [];

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!prefilter_(item, cutoff)) continue;

    var titleLower = item.headline.toLowerCase();
    if (historyTitles.indexOf(titleLower) !== -1) continue;
    if (seenTitles[titleLower]) continue;
    if (item.link && seenLinks[item.link]) continue;
    if (item.link && historyLinks[item.link]) continue;
    if (item.link && reviewedLinks[item.link]) { stats.skippedReviewed++; continue; }

    var fp = dealFingerprint_(item.headline);
    var isDup = false;
    for (var p = 0; p < historyPrints.length && !isDup; p++) {
      if (isSameDeal_(fp, historyPrints[p])) isDup = true;
    }
    for (var q = 0; q < batchPrints.length && !isDup; q++) {
      if (isSameDeal_(fp, batchPrints[q])) isDup = true;
    }
    if (isDup) continue;

    seenTitles[titleLower] = true;
    if (item.link) seenLinks[item.link] = true;
    batchPrints.push(fp);
    candidates.push(item);
  }
  stats.candidates = candidates.length;
  Logger.log("[프리필터 통과] " + candidates.length + "건 → Gemini 정제 (이미 심사된 " + stats.skippedReviewed + "건 제외)");

  // ── 4. Gemini 판정 + 필드 추출 (fail-closed) ──
  // 청크 단위로 즉시 시트에 적재한다. 예전에는 실행 맨 끝에 한 번만 적재해서
  // 6분 하드리밋에 걸리면 그날 결과가 통째로 사라졌다.
  var batchPairs = {};
  var written    = 0;       // 이번 실행에서 딜DB에 넣은 행 수
  var dryDeals   = [];
  var maxChunkMs = 0;

  for (var c = 0; c < candidates.length; c += EXTRACT_CHUNK) {
    var elapsed = new Date().getTime() - startedAt;
    var need    = Math.max(maxChunkMs, GEMINI_CHUNK_BUDGET_MS);
    if (elapsed + need > MAX_RUNTIME_MS) {
      Logger.log("[TIMEOUT GUARD] 남은 시간 부족 (" + Math.round(elapsed / 1000) + "s 경과) — 남은 " +
                 (candidates.length - c) + "건은 다음 실행에서 처리");
      stats.timedOut = true;
      break;
    }
    var chunk = candidates.slice(c, c + EXTRACT_CHUNK);
    var chunkStart = new Date().getTime();
    var deadline   = chunkStart + GEMINI_CHUNK_BUDGET_MS;

    var results = extractBatchWithGemini_(chunk, deadline);
    if (results === null && new Date().getTime() < deadline - 10000) {
      Utilities.sleep(2000);
      results = extractBatchWithGemini_(chunk, deadline);   // 1회 재시도 (예산 안에서만)
    }
    maxChunkMs = Math.max(maxChunkMs, new Date().getTime() - chunkStart);
    if (results === null) { stats.geminiFailed = true; continue; }  // 이 청크는 보류 (심사이력에도 안 남김 → 다음 실행에서 재심사)
    stats.reviewed += chunk.length;

    var chunkDeals = [];
    var reviewRows = [];
    var stamp = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm");
    for (var r = 0; r < chunk.length; r++) {
      var res = results[r];
      if (!res || !res.relevant) {
        Logger.log("  ✂ 탈락 │ " + chunk[r].headline);
        if (chunk[r].link) reviewRows.push([stamp, chunk[r].link, "무관", chunk[r].headline, chunk[r].feed]);
        continue;
      }

      // 같은 딜을 여러 매체가 전혀 다른 문장으로 쓰면 제목 지문으로는 못 잡는다.
      // Gemini가 뽑아낸 인수사·대상사 쌍이 딜의 실제 신원이므로 여기서 한 번 더 막는다.
      // (같은 딜이 M&A/지분투자로 갈려 분류되기도 하므로 유형은 키에 넣지 않는다)
      var pairKey = dealPairKey_(res.acquirer, res.target);
      if (pairKey) {
        if (historyPairs[pairKey] || batchPairs[pairKey]) {
          stats.pairDropped++;
          Logger.log("  ⊘ 동일 딜 중복 │ " + pairKey + " │ " + chunk[r].headline);
          if (chunk[r].link) reviewRows.push([stamp, chunk[r].link, "동일딜", chunk[r].headline, chunk[r].feed]);
          continue;
        }
        batchPairs[pairKey] = true;
      }

      chunkDeals.push({
        pubDate:  chunk[r].pubDate,
        titleEn:  chunk[r].headline,
        titleKo:  res.title_ko   || "",
        type:     res.type       || "M&A",
        acquirer: res.acquirer   || "",
        target:   res.target     || "",
        price:    res.price      || "비공개",
        region:   res.region     || "",
        domain:   res.domain     || "",
        summary:  res.summary_ko || "",
        link:     chunk[r].link,
        source:   chunk[r].feed
      });
    }

    stats.loaded += chunkDeals.length;
    if (isDryRun) {
      dryDeals = dryDeals.concat(chunkDeals);
    } else {
      // 후보가 최신순이므로 이번 실행분 아래에 이어 붙여 시트 상단 순서를 유지한다
      if (chunkDeals.length) written += appendDeals_(sheet, chunkDeals, 2 + written);
      if (reviewRows.length) appendReviewRows_(ss, reviewRows);
    }
  }

  if (stats.geminiFailed) {
    Logger.log("[GEMINI] 일부 청크 호출 실패 — 해당 청크는 적재 보류 (fail-closed)");
    toast_("Gemini 호출 일부 실패. testGeminiKey()로 키 상태를 확인하세요.", "⚠️ AI 정제 실패");
  }
  Logger.log("[최종 통과] " + stats.loaded + "건 (동일 딜 중복 " + stats.pairDropped + "건 제거)");

  if (isDryRun) {
    Logger.log("═══ DRY RUN — 시트 미기록 ═══");
    for (var z = 0; z < dryDeals.length; z++) {
      Logger.log((z + 1) + ". [" + dryDeals[z].type + "] " + dryDeals[z].acquirer + " → " + dryDeals[z].target + " │ " + dryDeals[z].titleEn);
    }
    return stats;
  }

  pruneSheet_(ss, REVIEW_SHEET, REVIEW_KEEP_ROWS);

  // 어떤 경로로든 들어온 중복(인수사·대상사 쌍 동일)은 매 실행 끝에 자동 정리한다
  try { stats.cleaned = cleanupDuplicates(true) || 0; } catch (ce) { Logger.log("[CLEANUP FAIL] " + ce); }
  try { ensureTriggers_(); } catch (te) { Logger.log("[TRIGGER FAIL] " + te); }

  if (written === 0) {
    toast_("신규 딜이 없습니다. (수집 " + items.length + "건 → AI 심사 " + stats.reviewed + "건)", "✔️ Verified");
  } else {
    toast_(written + "건의 신규 딜을 추가했습니다.", "🎉 Execution Completed");
  }
  return stats;
}

/** 딜 목록을 딜DB의 atRow 위치에 삽입. 넣은 행 수를 돌려준다. */
function appendDeals_(sheet, deals, atRow) {
  var rows = deals.map(function (d) {
    return [
      Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm"),
      Utilities.formatDate(parseDate_(d.pubDate), "Asia/Seoul", "yyyy-MM-dd"),
      d.type, d.titleEn, d.titleKo,
      d.acquirer, d.target, d.price, d.region, d.domain, d.summary,
      d.link, d.source
    ];
  });
  sheet.insertRowsBefore(atRow, rows.length);
  sheet.getRange(atRow, 1, rows.length, DEAL_COLS).setValues(rows);
  return rows.length;
}


// ============================================================
// 심사이력 / 실행로그 시트
// ============================================================
function reviewSheet_(ss, create) {
  var sh = ss.getSheetByName(REVIEW_SHEET);
  if (!sh && create) {
    sh = ss.insertSheet(REVIEW_SHEET);
    sh.appendRow(["판정일시", "링크", "판정", "제목", "출처"]);
    sh.getRange(1, 1, 1, 5).setFontWeight("bold").setBackground("#455a64").setFontColor("#ffffff");
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 심사이력의 링크 → true 맵 */
function loadReviewedLinks_(ss) {
  var map = {};
  var sh = reviewSheet_(ss, false);
  if (!sh || sh.getLastRow() <= 1) return map;
  var n = sh.getLastRow() - 1;
  var links = sh.getRange(2, 2, n, 1).getValues();
  for (var i = 0; i < links.length; i++) {
    var l = String(links[i][0] || "").trim();
    if (l) map[l] = true;
  }
  return map;
}

function appendReviewRows_(ss, rows) {
  var sh = reviewSheet_(ss, true);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
}

/** 아래로 이어 붙이는 시트에서 위쪽(오래된) 행을 잘라 keep 행만 남긴다 */
function pruneSheet_(ss, name, keep) {
  var sh = ss.getSheetByName(name);
  if (!sh) return;
  var n = sh.getLastRow() - 1;
  if (n > keep) sh.deleteRows(2, n - keep);
}

function runLogSheet_(ss) {
  var sh = ss.getSheetByName(RUNLOG_SHEET);
  if (!sh) {
    sh = ss.insertSheet(RUNLOG_SHEET);
    sh.appendRow(RUNLOG_HEADER);
    sh.getRange(1, 1, 1, RUNLOG_HEADER.length).setFontWeight("bold").setBackground("#455a64").setFontColor("#ffffff");
    sh.setFrozenRows(1);
  } else if (sh.getLastColumn() < RUNLOG_HEADER.length) {
    // 이전 버전에서 만든 시트 — 늘어난 열 헤더만 채운다
    var from = sh.getLastColumn() + 1;
    sh.getRange(1, from, 1, RUNLOG_HEADER.length - from + 1)
      .setValues([RUNLOG_HEADER.slice(from - 1)])
      .setFontWeight("bold").setBackground("#455a64").setFontColor("#ffffff");
  }
  return sh;
}
var RUNLOG_HEADER = ["실행시각", "모드", "소요(초)", "수집", "후보", "이미심사 제외", "심사", "적재", "동일딜 제거",
                     "Gemini 실패", "타임아웃", "오류", "Gemini 마지막 오류", "중복정리"];

/** 실행로그의 마지막 실제 수집(dry-run 제외) 1건. 없으면 null. */
function lastRunLog_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RUNLOG_SHEET);
  if (!sh || sh.getLastRow() <= 1) return null;
  var total = sh.getLastRow() - 1;
  var take  = Math.min(total, 20);
  var vals  = sh.getRange(2 + total - take, 1, take, RUNLOG_HEADER.length).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    var r = vals[i];
    if (String(r[1] || "").indexOf("dry") === 0) continue;
    var at = (r[0] instanceof Date) ? r[0] : new Date(String(r[0]).replace(" ", "T"));
    if (isNaN(at.getTime())) continue;
    return { at: at, mode: String(r[1] || ""), error: String(r[11] || ""),
             geminiFailed: String(r[9] || "") === "Y", timedOut: String(r[10] || "") === "Y" };
  }
  return null;
}

function writeRunLog_(mode, startedAt, stats, error) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = runLogSheet_(ss);
  sh.appendRow([
    Utilities.formatDate(new Date(startedAt), "Asia/Seoul", "yyyy-MM-dd HH:mm:ss"),
    mode,
    Math.round((new Date().getTime() - startedAt) / 1000),
    stats.fetched || 0, stats.candidates || 0, stats.skippedReviewed || 0, stats.reviewed || 0,
    stats.loaded || 0, stats.pairDropped || 0,
    stats.geminiFailed ? "Y" : "", stats.timedOut ? "Y" : "",
    String(error || "").substring(0, 500),
    String(LAST_GEMINI_ERROR || "").substring(0, 300),
    stats.cleaned || 0
  ]);
  pruneSheet_(ss, RUNLOG_SHEET, RUNLOG_KEEP_ROWS);
}

/** ?run=status 용: 최근 n회 실행 요약 */
function recentRunLogs_(ss, n) {
  var sh = ss.getSheetByName(RUNLOG_SHEET);
  if (!sh || sh.getLastRow() <= 1) return [];
  var total = sh.getLastRow() - 1;
  var take  = Math.min(n, total);
  var vals  = sh.getRange(2 + total - take, 1, take, RUNLOG_HEADER.length).getDisplayValues();
  return vals.reverse().map(function (r) {
    return { at: r[0], mode: r[1], sec: r[2], fetched: r[3], candidates: r[4], skippedReviewed: r[5],
             reviewed: r[6], loaded: r[7], pairDropped: r[8], geminiFailed: r[9], timedOut: r[10],
             error: r[11], geminiError: r[12], cleaned: r[13] };
  });
}

// ============================================================
// Gemini 판정 + 추출 (핵심)
// ============================================================
function extractBatchWithGemini_(chunk, deadline) {
  var key = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!key) {
    LAST_GEMINI_ERROR = "API 키 없음";
    Logger.log("[GEMINI] API 키 없음. saveGeminiKey() 를 먼저 실행하세요.");
    return null;
  }

  var numbered = chunk.map(function (x, i) {
    var line = (i + 1) + ". " + x.headline;
    if (x.desc) line += " — " + x.desc;
    return line;
  }).join("\n");

  var prompt =
    "You are a deal-intelligence extractor for the GLOBAL ADVERTISING/MARKETING INDUSTRY.\n" +
    "For each numbered news item (headline, optionally followed by a snippet after '—'), decide whether it " +
    "REPORTS a specific corporate deal where at least one named party operates in advertising, marketing, " +
    "adtech, martech, media, or PR. Deal types:\n" +
    '- "M&A": acquisition, merger, takeover, buyout (announced, agreed, or completed)\n' +
    '- "지분투자": equity/stake investment, capital participation, minority investment in a company\n' +
    '- "파트너십": corporate-level strategic partnership, alliance, or joint venture between named companies\n' +
    "Japanese items count the same way (買収/子会社化=M&A, 出資/資本参加=지분투자, 資本業務提携/合弁=파트너십).\n\n" +
    "relevant=false for everything else, including: M&A guides/reports/surveys/trend pieces/market commentary; " +
    "lawsuits/trials/regulatory disputes; broadcast/streaming/sports/content rights or licensing deals; " +
    "customer/user/talent acquisition or CAC topics; earnings/stock/forecast news; executive appointments or " +
    "profiles; agency account wins or media reviews; one-off campaign collaborations, sponsorships, or " +
    "co-branded products; experiential-marketing 'takeovers' (a brand taking over a store/bar/venue/billboard/" +
    "homepage/social account), pop-ups, store openings, installations; stories where a past deal is only " +
    "background (e.g. growth or an executive's career after an acquisition).\n" +
    "Today is " + Utilities.formatDate(new Date(), "Asia/Seoul", "MMMM yyyy") + ". " +
    "Also relevant=false if you recognize the deal as announced or completed before 2025 (old stories are " +
    "sometimes re-indexed with fresh dates).\n\n" +
    "For each relevant item extract:\n" +
    '- "type": "M&A" | "지분투자" | "파트너십"\n' +
    '- "acquirer": acquiring/investing company, or partner 1 (English name)\n' +
    '- "target": acquired/investee company, or partner 2 (English name)\n' +
    '- "price": deal value as written (e.g. "$150M", "Rs 800 crore", "¥100億"); "비공개" if undisclosed or not mentioned\n' +
    '- "region": target company\'s country/region in KOREAN (e.g. "미국", "영국", "일본", "인도", "글로벌")\n' +
    '- "domain": main business domain in 1-2 words (e.g. "AdTech", "MarTech", "AI", "리테일미디어", "크리에이티브", "PR", "디지털마케팅")\n' +
    '- "title_ko": natural Korean translation of the headline; KEEP company names in English\n' +
    '- "summary_ko": ONE concise Korean sentence in noun-phrase ending style (e.g. "WPP가 InfoSum 인수로 데이터 역량 강화", ' +
    '"Dentsu와 Salesforce의 CDP 분야 전략적 파트너십 체결"); company names in English; never end with ~했다/~입니다\n\n' +
    "Return ONLY a JSON array with EXACTLY one object per input item, in the same order:\n" +
    '- not relevant → {"i":N,"relevant":false}\n' +
    '- relevant     → {"i":N,"relevant":true,"type":"...","acquirer":"...","target":"...","price":"...","region":"...","domain":"...","title_ko":"...","summary_ko":"..."}\n' +
    "No other text.\n\n" +
    "Items:\n" + numbered;

  var payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json" }
  };

  try {
    var res = geminiFetchWithFallback_(key, payload, deadline);
    if (!res) return null;   // LAST_GEMINI_ERROR 는 내부에서 세팅됨

    var body = JSON.parse(res.getContentText());
    var text = body.candidates[0].content.parts[0].text;
    var arr = JSON.parse(String(text).replace(/```json|```/g, "").trim());

    if (!Array.isArray(arr) || arr.length !== chunk.length) {
      LAST_GEMINI_ERROR = "응답 개수 불일치 (요청 " + chunk.length + " / 응답 " + (arr && arr.length) + ")";
      Logger.log("[GEMINI] " + LAST_GEMINI_ERROR);
      return null;
    }

    // i 필드 기준으로 정렬 보정 (순서 흔들림 대비)
    var byIndex = new Array(chunk.length);
    for (var k = 0; k < arr.length; k++) {
      var idx = (arr[k] && typeof arr[k].i === "number") ? arr[k].i - 1 : k;
      if (idx >= 0 && idx < chunk.length && !byIndex[idx]) byIndex[idx] = arr[k];
    }
    for (var m = 0; m < chunk.length; m++) {
      if (!byIndex[m]) byIndex[m] = arr[m] || { relevant: false };
    }
    return byIndex;

  } catch (e) {
    LAST_GEMINI_ERROR = String(e);
    Logger.log("[GEMINI FAIL] " + e);
    return null;
  }
}

/**
 * GEMINI_MODELS 순서대로 호출. 503(과부하)/429(쿼터)는 같은 모델에서 백오프 재시도 후 다음 모델로 넘어간다.
 * 그 외 4xx(잘못된 모델명·권한 등)도 다음 모델을 시도한다. 성공하면 HTTPResponse, 전부 실패하면 null.
 * deadline(ms epoch)을 넘기면 남은 재시도·폴백을 포기한다 — 모델 4개 × 3회 재시도가 전부 실패하면
 * 한 청크에 수 분이 걸려 6분 하드리밋에 걸리던 문제 방지.
 */
function geminiFetchWithFallback_(key, payload, deadline) {
  var lastErr = "";
  var first = true;
  for (var m = 0; m < GEMINI_MODELS.length; m++) {
    var model = GEMINI_MODELS[m];
    var url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key);
    for (var attempt = 0; attempt <= GEMINI_RETRY_WAITS_MS.length; attempt++) {
      if (!first && deadline && new Date().getTime() > deadline) {
        lastErr += " │ 청크 시간 예산 초과로 중단";
        Logger.log("[GEMINI] 청크 시간 예산 초과 — 재시도/폴백 중단");
        LAST_GEMINI_ERROR = lastErr;
        return null;
      }
      first = false;
      var res = UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      if (code === 200) {
        if (m > 0 || attempt > 0) Logger.log("[GEMINI] " + model + " 성공 (폴백 " + m + " / 재시도 " + attempt + ")");
        return res;
      }
      lastErr = "HTTP " + code + " (" + model + ") │ " + res.getContentText().substring(0, 300);
      Logger.log("[GEMINI] " + lastErr);
      var transient = (code === 503 || code === 429 || code === 500);
      if (!transient) break;                                   // 모델 자체 문제 → 다음 모델
      if (attempt < GEMINI_RETRY_WAITS_MS.length) Utilities.sleep(GEMINI_RETRY_WAITS_MS[attempt]);
    }
  }
  LAST_GEMINI_ERROR = lastErr;
  return null;
}


// ============================================================
// 프리필터
// ============================================================
function prefilter_(item, cutoff) {
  if (!item.title) return false;

  var pd = new Date(item.pubDate);
  if (isNaN(pd.getTime()) || pd.getTime() < cutoff) return false;

  var head = item.headline;
  var text = head + " " + (item.desc || "");

  if (matchAny_(text, HARD_BLOCK)) return false;

  var hints = isJa_(head) ? DEAL_HINTS_JA : DEAL_HINTS_EN.concat(DEAL_HINTS_JA);
  if (!matchAny_(text, hints)) return false;

  // 신뢰 소스가 아니면 앵커(감시 대상 키워드) 필수 — 일반 쿼리 노이즈 억제
  if (!item.trusted && !matchAny_(text, item.anchors)) return false;

  return true;
}


// ============================================================
// 수집
// ============================================================
function buildFeedPlan_() {
  var plan = [];

  for (var e = 0; e < WATCH_ENTITIES.length; e++) {
    var entity = WATCH_ENTITIES[e];
    for (var d = 0; d < entity.eds.length; d++) {
      var edKey = entity.eds[d];
      var isJaEd = (edKey === "JP_JA");
      var term  = (isJaEd && entity.jaTerm) ? entity.jaTerm : entity.term;
      var orRun = isJaEd ? DEAL_OR_RUN_JA : DEAL_OR_RUN;
      plan.push({
        label:   entity.term + " @" + edKey,
        url:     "https://news.google.com/rss/search?q=" + encodeURIComponent([term, orRun, TIME_WINDOW].join(" ")) + "&" + EDITIONS[edKey],
        anchors: entity.anchors,
        trusted: false
      });
    }
  }

  for (var s = 0; s < SOURCE_FEEDS.length; s++) {
    var src = SOURCE_FEEDS[s];
    for (var t = 0; t < src.eds.length; t++) {
      plan.push({
        label:   src.site + " @" + src.eds[t],
        url:     "https://news.google.com/rss/search?q=" + encodeURIComponent(["site:" + src.site, DEAL_OR_RUN, TIME_WINDOW].join(" ")) + "&" + EDITIONS[src.eds[t]],
        anchors: AD_DOMAIN_PATTERNS,
        trusted: true
      });
    }
  }

  return plan;
}

function fetchAllFeeds_(startedAt) {
  var plan = buildFeedPlan_();
  var collected = [];

  for (var b = 0; b < plan.length; b += FETCH_BATCH_SIZE) {
    if (startedAt && (new Date().getTime() - startedAt) > MAX_RUNTIME_MS * 0.6) {
      Logger.log("[TIMEOUT GUARD] 수집 단계 시간 초과 — 조기 종료");
      return collected;
    }

    var chunk = plan.slice(b, b + FETCH_BATCH_SIZE);
    var requests = chunk.map(function (f) {
      return { url: f.url, muteHttpExceptions: true };
    });

    var responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (err) {
      Logger.log("[BATCH FAIL] " + err);
      continue;
    }

    for (var r = 0; r < responses.length; r++) {
      var meta = chunk[r];
      try {
        if (responses[r].getResponseCode() !== 200) {
          Logger.log("[" + meta.label + "] HTTP " + responses[r].getResponseCode());
          continue;
        }
        var xml = XmlService.parse(responses[r].getContentText());
        var channel = xml.getRootElement().getChild("channel");
        if (!channel) continue;

        var list  = channel.getChildren("item");
        var limit = Math.min(list.length, MAX_ITEMS_PER_FEED);

        for (var i = 0; i < limit; i++) {
          var rawTitle = (list[i].getChildText("title") || "").trim();
          collected.push({
            title:    rawTitle,
            headline: extractHeadline_(rawTitle),
            desc:     stripHtml_(list[i].getChildText("description") || "").substring(0, 200),
            link:     (list[i].getChildText("link")    || "").trim(),
            pubDate:  (list[i].getChildText("pubDate") || "").trim(),
            feed:     meta.label,
            anchors:  meta.anchors,
            trusted:  meta.trusted
          });
        }
      } catch (err2) {
        Logger.log("[PARSE FAIL] " + meta.label + " / " + err2);
      }
    }

    Utilities.sleep(BATCH_SLEEP_MS);
  }

  return collected;
}


// ============================================================
// 헬퍼
// ============================================================
function extractHeadline_(title) {
  var idx = title.lastIndexOf(" - ");
  return (idx > 10) ? title.substring(0, idx).trim() : title;
}

function stripHtml_(s) {
  return String(s).replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
}

function isJa_(text) {
  return /[぀-ヿ]/.test(text) || /[一-龯]{2,}/.test(text);
}

function matchAny_(text, patterns) {
  if (!patterns || !patterns.length) return null;
  for (var i = 0; i < patterns.length; i++) {
    if (patterns[i].test(text)) return patterns[i].source;
  }
  return null;
}

function ensureHeader_(sheet) {
  if (sheet.getLastRow() > 0) return;
  sheet.appendRow([
    "수집일시", "기사일자", "유형", "제목 (EN)", "제목 (KO)",
    "인수·투자기업", "대상기업", "딜 규모", "지역", "영역", "요약", "링크", "출처"
  ]);
  sheet.getRange(1, 1, 1, DEAL_COLS)
       .setFontWeight("bold").setBackground("#1a237e").setFontColor("#ffffff").setHorizontalAlignment("center");
  sheet.setFrozenRows(1);
}

function dealFingerprint_(title) {
  var core = extractHeadline_(String(title));
  var norm = core.toLowerCase()
    .replace(/['‘’`´]s\b/g, "")
    .replace(CJK_STRIP, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (var a = 0; a < COMPANY_ALIASES.length; a++) {
    norm = norm.replace(COMPANY_ALIASES[a][0], COMPANY_ALIASES[a][1]);
  }

  var seen = {};
  var tokens = [];
  var words = norm.split(" ");
  for (var w = 0; w < words.length; w++) {
    var word = words[w];

    // 일본어·중국어는 띄어쓰기가 없어 단어로 쪼갤 수 없다.
    // 예전에는 여기서 통째로 버려져 일본어 기사가 중복 검사를 무조건 통과했다.
    // 2글자 조각(bigram)으로 나눠 "電通総研"·"伊藤忠" 같은 고유명사가 겹치게 한다.
    if (CJK_CHAR.test(word)) {
      for (var j = 0; j + 1 < word.length; j++) {
        var bg = word.substring(j, j + 2);
        if (seen[bg]) continue;
        seen[bg] = true;
        tokens.push(bg);
      }
      continue;
    }

    if (word.length < 3) continue;
    if (GENERIC_TOKENS[word]) continue;
    if (seen[word]) continue;
    seen[word] = true;
    tokens.push(word);
  }
  return tokens;
}

function isSameDeal_(fpA, fpB) {
  if (!fpA.length || !fpB.length) return false;
  var set = {};
  for (var b = 0; b < fpB.length; b++) set[fpB[b]] = true;
  var shared = 0;
  for (var a = 0; a < fpA.length; a++) if (set[fpA[a]]) shared++;
  if (shared < 2) return false;
  return (shared / Math.min(fpA.length, fpB.length)) >= 0.5;
}

// 지문·회사명 정규화에서 살려둘 문자 (히라가나·가타카나·한자)
var CJK_CHAR  = /[\u3040-\u30ff\u4e00-\u9fff]/;
var CJK_STRIP = /[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g;

// 법인격 접미어 — "Itochu"와 "ITOCHU Corporation"을 같은 회사로 보게 한다
var CORP_SUFFIX = /\b(group|groupe|holding|holdings|corporation|corp|company|co|inc|incorporated|ltd|limited|llc|lp|plc|sa|nv|ag|gmbh|pte|pvt|kk|the|and)\b/g;

function companyKey_(name) {
  var s = String(name || "").toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7a3]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (var a = 0; a < COMPANY_ALIASES.length; a++) {
    s = s.replace(COMPANY_ALIASES[a][0], COMPANY_ALIASES[a][1]);
  }
  return s.replace(CORP_SUFFIX, " ").replace(/\s+/g, " ").trim();
}

/** 딜의 신원 = 방향 무관한 회사 쌍. 한쪽이라도 비면 판정 불가이므로 "" 반환. */
function dealPairKey_(acquirer, target) {
  var a = companyKey_(acquirer);
  var b = companyKey_(target);
  if (!a || !b) return "";
  return (a < b) ? (a + "|" + b) : (b + "|" + a);
}

// 웹앱/트리거 컨텍스트에서 toast가 예외를 던지지 않도록 감싼다
function toast_(msg, title) {
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, title || "", 6); } catch (e) {}
}

function parseDate_(raw) {
  var d = new Date(raw);
  return isNaN(d.getTime()) ? new Date() : d;
}
