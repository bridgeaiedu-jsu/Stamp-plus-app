/* ╔══════════════════════════════════════════════════════════════════╗
   ║  단골 적립 스탬프 — 구글 장부 관리인 (구글 앱스 스크립트)         ║
   ╚══════════════════════════════════════════════════════════════════╝

   이 코드는 "구글 스프레드시트"를 장부로 쓰는 관리인이에요.
   · 손님 화면(index.html): 번호 4자리를 넣으면 "개수"만 알려줘요. (누구나 조회 가능, 읽기만 가능, 번호가 인터넷 주소에 남지 않게 POST로 보내요)
   · 사장님 화면(admin.html): 적립 / 취소 / 사용 완료. (사장님 열쇠가 있어야만 가능)

   ■ 어디에 붙여넣나요?
     1) 구글 스프레드시트를 새로 만들고 → 메뉴 "확장 프로그램" → "Apps Script"를 엽니다.
     2) 처음에 있던 코드를 모두 지우고, 이 파일의 내용을 전부 붙여넣습니다.
     3) 바로 아래 "사장님열쇠"를 사장님만 아는 긴 글자로 바꿉니다. (자세한 순서는 "구글시트 설정 안내.md")

   ■ ⚠ 꼭 지켜주세요
     · 사장님열쇠는 남에게 알려주지 마세요. 이 열쇠가 있으면 누구나 스탬프를 마음대로 바꿀 수 있어요.
     · 이 파일(서버코드.gs)을 인터넷(GitHub 등)에 올릴 때는 열쇠 자리를 바꾸기 전 "예시 글자" 상태로만 올리세요.
       (진짜 열쇠는 구글 Apps Script 화면 안에서만 적고, 이 컴퓨터 파일에는 적지 않는 것을 권해요.)
     · 스프레드시트를 다른 사람과 "공유"하지 마세요. 손님 번호가 들어 있어요.
     · 구글 계정에는 "2단계 인증"을 켜 두세요.
*/

// ───────────────────────── 설정 (여기만 고치면 돼요) ─────────────────────────
const 사장님열쇠 = "여기에-사장님만-아는-긴-글자를-적으세요";   // ★ 반드시 바꾸세요 (영어·숫자 섞어 16글자 이상 추천)
const 목표개수 = 10;                  // 몇 개를 모으면 무료 음료인지 (두 화면의 숫자와 같게)
const 중복확인_초 = 60;               // 같은 번호로 이 시간(초) 안에 또 적립하면 "방금 적립했어요" 확인을 요구해요
const 조회한도_분당 = 40;             // 손님 조회가 1분에 이 횟수를 넘으면 잠깐 막아요 (남의 번호 맞히기 방지)
const 열쇠틀림한도 = 10;              // 5분 안에 열쇠를 이만큼 틀리면 5분간 사장님 기능을 막아요
const 시간대 = "Asia/Seoul";
// ────────────────────────────────────────────────────────────────────────────

const 장부이름 = "장부";   // 번호 / 개수 / 마지막적립 / 수정시각
const 기록이름 = "기록";   // 날짜 / 시각 / 번호 / 동작  (오늘 적립 횟수를 세는 데 써요)

/* ===================== 들어오는 요청 처리 ===================== */

// 주소창에 직접 열어 보는 용도: ?action=ping 으로 "관리인이 살아 있는지" 확인할 수 있어요.
// (?action=lookup&phone=1234 도 되지만, 번호가 주소에 남아서 손님 화면은 쓰지 않아요.)
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === "ping") return 응답({ ok: true });
  if (p.action !== "lookup") return 응답({ ok: false, reason: "bad", msg: "알 수 없는 요청이에요." });

  return 손님조회(번호정리(p.phone));
}

// 손님 조회 (읽기 전용). 개수만 알려주고, 너무 자주 부르면 잠깐 막아요.
// ※ 손님 화면은 번호가 주소(URL)에 남지 않도록 POST 방식으로 불러요. (아래 doPost 참고)
function 손님조회(번호) {
  if (!번호) return 응답({ ok: false, reason: "bad", msg: "번호 4자리를 확인해 주세요." });
  return 잠금실행(function () {
    if (한도초과("lookup", 조회한도_분당, 60)) {
      return 응답({ ok: false, reason: "busy", msg: "조회가 많아요. 잠시 후 다시 해 주세요." });
    }
    const 줄 = 줄찾기(장부시트(), 번호);
    if (!줄) return 응답({ ok: true, known: false, count: 0 });
    return 응답({ ok: true, known: true, count: 개수읽기(장부시트(), 줄) });
  });
}

// 사장님 화면: 글자(JSON)로 { key, action, phone, confirmed } 를 보내요
function doPost(e) {
  let 요청;
  try {
    요청 = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return 응답({ ok: false, reason: "bad", msg: "요청이 올바르지 않아요." });
  }

  // 손님 조회는 열쇠 없이 누구나 (개수만 알려줘요)
  if (요청.action === "lookup") return 손님조회(번호정리(요청.phone));

  return 잠금실행(function () {
    // 열쇠 확인 (많이 틀리면 잠시 막아요)
    if (열쇠막힘()) return 응답({ ok: false, reason: "busy", msg: "열쇠를 너무 많이 틀렸어요. 5분 뒤에 다시 해 주세요." });
    if (!열쇠맞음(요청.key)) {
      열쇠틀림기록();
      return 응답({ ok: false, reason: "auth", msg: "사장님 열쇠가 맞지 않아요." });
    }

    const 동작 = 요청.action;
    if (동작 === "today") return 응답({ ok: true, today: 오늘횟수(), date: 오늘날짜() });

    const 번호 = 번호정리(요청.phone);
    if (!번호) return 응답({ ok: false, reason: "bad", msg: "번호 4자리를 확인해 주세요." });

    if (동작 === "status") return 응답({ ok: true, count: 지금개수(번호), today: 오늘횟수(), date: 오늘날짜() });
    if (동작 === "add") return 적립(번호, !!요청.confirmed);
    if (동작 === "cancel") return 취소(번호);
    if (동작 === "use") return 사용완료(번호);
    return 응답({ ok: false, reason: "bad", msg: "알 수 없는 동작이에요." });
  });
}

/* ===================== 사장님 동작 ===================== */

function 적립(번호, 확인함) {
  const 시트 = 장부시트();
  const 줄 = 줄찾기(시트, 번호);
  const 개수 = 줄 ? 개수읽기(시트, 줄) : 0;

  if (개수 >= 목표개수) return 응답({ ok: false, reason: "full", count: 개수 });

  // 방금(60초 안에) 적립한 번호면, 사장님이 한 번 더 확인했을 때만 진행해요
  if (줄 && !확인함) {
    const 마지막 = Number(시트.getRange(줄, 3).getValue()) || 0;
    if (Date.now() - 마지막 < 중복확인_초 * 1000) return 응답({ ok: false, reason: "recent", count: 개수 });
  }

  const 새개수 = 개수 + 1;
  if (줄) {
    시트.getRange(줄, 2, 1, 3).setValues([[새개수, Date.now(), 지금글자()]]);
  } else {
    새줄쓰기(시트, 번호, 새개수);
  }
  기록쓰기(번호, "적립");
  return 응답({ ok: true, count: 새개수, today: 오늘횟수(), date: 오늘날짜() });
}

function 취소(번호) {
  const 시트 = 장부시트();
  const 줄 = 줄찾기(시트, 번호);
  const 개수 = 줄 ? 개수읽기(시트, 줄) : 0;
  if (개수 <= 0) return 응답({ ok: false, reason: "zero", count: 0 });

  const 새개수 = 개수 - 1;
  if (새개수 === 0) {
    시트.deleteRow(줄);                                  // 0개가 되면 그 손님 줄은 지워요 (정보 최소화)
  } else {
    // 마지막적립 시각을 0으로 → 곧바로 다시 적립해도 "방금 적립" 확인이 뜨지 않아요
    시트.getRange(줄, 2, 1, 3).setValues([[새개수, 0, 지금글자()]]);
  }
  // 오늘 이 번호로 적립한 기록이 있으면 "취소됨"으로 바꿔서 오늘 횟수에서 빼요
  const 기록 = 기록시트();
  const 오늘 = 오늘날짜();
  const 값 = 기록.getDataRange().getValues();
  for (let i = 값.length - 1; i >= 1; i--) {
    if (글자(값[i][0]) === 오늘 && 시트번호(값[i][2]) === 번호 && 값[i][3] === "적립") {
      기록.getRange(i + 1, 4).setValue("적립(취소됨)");
      break;
    }
  }
  기록쓰기(번호, "취소");
  return 응답({ ok: true, count: 새개수, today: 오늘횟수(), date: 오늘날짜() });
}

function 사용완료(번호) {
  const 시트 = 장부시트();
  const 줄 = 줄찾기(시트, 번호);
  const 개수 = 줄 ? 개수읽기(시트, 줄) : 0;
  if (개수 < 목표개수) return 응답({ ok: false, reason: "notfull", count: 개수 });

  시트.deleteRow(줄);   // 0개로 초기화 = 그 손님 줄 삭제
  기록쓰기(번호, "사용완료");
  return 응답({ ok: true, count: 0, today: 오늘횟수(), date: 오늘날짜() });
}

/* ===================== 장부(스프레드시트) 읽고 쓰기 ===================== */

function 장부시트() { return 시트가져오기(장부이름, ["번호", "개수", "마지막적립(ms)", "수정시각"], ["@", "0", "0", "@"]); }
function 기록시트() { return 시트가져오기(기록이름, ["날짜", "시각", "번호", "동작"], ["@", "@", "@", "@"]); }

// 시트가 없으면 만들어요. 번호·날짜 칸은 "글자"로 저장해서 0123 같은 번호가 123으로 바뀌지 않게 해요
function 시트가져오기(이름, 머리글, 서식) {
  const 문서 = SpreadsheetApp.getActiveSpreadsheet();
  let 시트 = 문서.getSheetByName(이름);
  if (!시트) {
    시트 = 문서.insertSheet(이름);
    시트.getRange(1, 1, 1, 머리글.length).setValues([머리글]);
    for (let c = 0; c < 서식.length; c++) 시트.getRange(2, c + 1, 시트.getMaxRows() - 1, 1).setNumberFormat(서식[c]);
    시트.setFrozenRows(1);
  }
  return 시트;
}

function 줄찾기(시트, 번호) {
  const 끝 = 시트.getLastRow();
  if (끝 < 2) return 0;
  const 값 = 시트.getRange(2, 1, 끝 - 1, 1).getValues();
  for (let i = 0; i < 값.length; i++) if (시트번호(값[i][0]) === 번호) return i + 2;
  return 0;
}

function 개수읽기(시트, 줄) { return Number(시트.getRange(줄, 2).getValue()) || 0; }
function 지금개수(번호) { const 시트 = 장부시트(); const 줄 = 줄찾기(시트, 번호); return 줄 ? 개수읽기(시트, 줄) : 0; }

function 새줄쓰기(시트, 번호, 개수) {
  const 줄 = 시트.getLastRow() + 1;
  시트.getRange(줄, 1).setNumberFormat("@").setValue(번호);
  시트.getRange(줄, 2, 1, 3).setValues([[개수, Date.now(), 지금글자()]]);
}

function 기록쓰기(번호, 동작) {
  const 시트 = 기록시트();
  const 줄 = 시트.getLastRow() + 1;
  시트.getRange(줄, 1, 1, 4).setNumberFormat("@").setValues([[오늘날짜(), 시각글자(), 번호, 동작]]);
}

function 오늘횟수() {
  const 시트 = 기록시트();
  const 끝 = 시트.getLastRow();
  if (끝 < 2) return 0;
  const 값 = 시트.getRange(2, 1, 끝 - 1, 4).getValues();
  const 오늘 = 오늘날짜();
  let 세기 = 0;
  for (let i = 0; i < 값.length; i++) if (글자(값[i][0]) === 오늘 && 값[i][3] === "적립") 세기++;
  return 세기;
}

/* ===================== 작은 도구들 ===================== */

function 응답(객체) {
  return ContentService.createTextOutput(JSON.stringify(객체)).setMimeType(ContentService.MimeType.JSON);
}

// 밖에서 들어온 번호: 숫자 4자리가 아니면 받지 않아요 ("" 를 돌려줘요)
function 번호정리(값) {
  const 글 = String(값 === undefined || 값 === null ? "" : 값).trim();
  return /^\d{4}$/.test(글) ? 글 : "";
}

// 시트에 적힌 번호를 읽을 때: 시트가 0123 을 숫자 123 으로 바꿔 놨더라도 "0123" 으로 되돌려요
function 시트번호(값) {
  const 글 = String(값 === undefined || 값 === null ? "" : 값).replace(/\D/g, "");
  return 글.length === 0 || 글.length > 4 ? "" : 글.padStart(4, "0");
}

function 글자(값) {
  if (값 instanceof Date) return Utilities.formatDate(값, 시간대, "yyyy-MM-dd");
  return String(값);
}

function 오늘날짜() { return Utilities.formatDate(new Date(), 시간대, "yyyy-MM-dd"); }
function 시각글자() { return Utilities.formatDate(new Date(), 시간대, "HH:mm:ss"); }
function 지금글자() { return Utilities.formatDate(new Date(), 시간대, "yyyy-MM-dd HH:mm:ss"); }

// 한 번에 하나씩만 처리해요 (동시에 눌러도 기록이 꼬이지 않게)
function 잠금실행(할일) {
  const 잠금 = LockService.getScriptLock();
  if (!잠금.tryLock(10000)) return 응답({ ok: false, reason: "busy", msg: "지금 처리 중이에요. 잠시 후 다시 해 주세요." });
  try {
    return 할일();
  } finally {
    잠금.releaseLock();
  }
}

// 이름별 횟수를 세서 한도를 넘었는지 알려줘요 (1분 단위 등)
function 한도초과(이름, 한도, 초) {
  const 캐시 = CacheService.getScriptCache();
  const 키 = 이름 + "-" + Math.floor(Date.now() / (초 * 1000));
  const 횟수 = Number(캐시.get(키) || 0) + 1;
  캐시.put(키, String(횟수), 초 * 2);
  return 횟수 > 한도;
}

function 열쇠맞음(받은열쇠) {
  const 받음 = String(받은열쇠 || "");
  if (받음.length !== 사장님열쇠.length) return false;
  let 다름 = 0;
  for (let i = 0; i < 받음.length; i++) 다름 |= 받음.charCodeAt(i) ^ 사장님열쇠.charCodeAt(i);
  return 다름 === 0;
}

function 열쇠막힘() {
  const 캐시 = CacheService.getScriptCache();
  return Number(캐시.get("틀림-" + Math.floor(Date.now() / 300000)) || 0) >= 열쇠틀림한도;
}

function 열쇠틀림기록() {
  const 캐시 = CacheService.getScriptCache();
  const 키 = "틀림-" + Math.floor(Date.now() / 300000);
  캐시.put(키, String(Number(캐시.get(키) || 0) + 1), 600);
}

/* ===================== (선택) 오래된 기록 정리 =====================
   손님 정보를 오래 들고 있지 않도록, 필요할 때 사장님이 직접 실행하는 정리 도구예요.
   실행 방법: Apps Script 화면 위쪽에서 함수 이름을 "오래된기록정리"로 고르고 "실행"을 누르세요.
   · 기록 시트에서 90일이 지난 줄을 지워요.
   · 장부 시트에서 마지막 적립이 180일(약 6개월) 넘은 손님 줄을 지워요. */
function 오래된기록정리() {
  const 기록 = 기록시트();
  const 값 = 기록.getDataRange().getValues();
  const 기준 = Utilities.formatDate(new Date(Date.now() - 90 * 86400000), 시간대, "yyyy-MM-dd");
  for (let i = 값.length - 1; i >= 1; i--) if (글자(값[i][0]) < 기준) 기록.deleteRow(i + 1);

  const 시트 = 장부시트();
  const 장부값 = 시트.getDataRange().getValues();
  for (let i = 장부값.length - 1; i >= 1; i--) {
    const 마지막 = Number(장부값[i][2]) || 0;
    if (마지막 > 0 && Date.now() - 마지막 > 180 * 86400000) 시트.deleteRow(i + 1);
  }
}
