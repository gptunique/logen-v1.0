// api/track.js

// ---------- 공통 상수 및 헬퍼 함수 (기존 로직 유지) ----------

const STATUS_MAP = [
  [/집하|수거완료|집하처리|집하 완료/, "PICKED_UP"],
  [/간선상차|간선 상차|간선하차|간선 하차|행낭|환적/, "IN_TRANSIT"],
  [/터미널입고|터미널 입고|터미널도착|허브|중앙터미널|센터 도착/, "AT_HUB"],
  [/배송출발|배달출발|배송출고|배달출고|배송 출발/, "OUT_FOR_DELIVERY"],
  [/배송완료|배달완료|배송 완료|배달 완료/, "DELIVERED"],
  [/주소불명|수취거부|파손|보류|반송|이상|예외/, "EXCEPTION"],
];

function toStandardStatus(raw) {
  if (!raw) return "UNKNOWN";
  for (const [re, val] of STATUS_MAP) {
    if (re.test(raw)) return val;
  }
  return "UNKNOWN";
}

function parseInvoices(param) {
  if (!param) return [];
  return param
    .split(/[\s,]+/)
    .map((x) => x.replace(/[^0-9]/g, ""))
    .filter((x) => x.length >= 10 && x.length <= 13);
}

function buildTrackUrl(inv) {
  return `https://www.ilogen.com/web/personal/trace/${inv}`;
}

function sanitize(s) {
  return (s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function toIsoIfPossible(s) {
  if (!s) return null;
  const t = s.replace(/[.]/g, "-");
  const d = new Date(t);
  if (!isNaN(+d)) return d.toISOString();
  return s;
}

// ---------- 로젠 HTML 통신 ----------

async function fetchLogenHtml(invoice, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Node.js 18+ (Vercel 기본값)에서는 global fetch 사용 가능
    const res = await fetch(buildTrackUrl(invoice), {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/123.0 Safari/537.36",
      },
    });

    if (!res.ok) {
      throw new Error(`origin HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 로젠 HTML 파싱 (기존 로직 동일) ----------

function parseLogenHtml(invoice, html) {
  // 1) 라벨 기반 현재/배송 상태
  let rawStatus =
    (html.match(/현재상태[^<]*<[^>]*>\s*([^<\n]+)/) ||
      html.match(/배송상태[^<]*<[^>]*>\s*([^<\n]+)/) ||
      [, ""])[1].trim();

  // 2) 최종 이벤트 시각
  let lastEventAtRaw =
    (html.match(
      /(배달출발|배달완료|배송출발|배송완료|간선상차|간선하차|집하)[^\d]*(\d{4}[-./]\d{1,2}[-./]\d{1,2}[^<\n]+)/
    ) || [, ""])[2]?.replace(/\./g, "-") || null;

  // 3) 출발/도착 점소
  let origin =
    (html.match(/집하점소[^<]*<[^>]*>\s*([^<\n]+)/) || [, ""])[1].trim() || null;
  let destination =
    (html.match(/도착점소[^<]*<[^>]*>\s*([^<\n]+)/) || [, ""])[1].trim() || null;

  // 4) 이력 테이블 파싱
  const history = [];
  const rowRe =
    /<tr[^>]*>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<\/tr>/gims;

  let m;
  let hit = 0;
  while ((m = rowRe.exec(html)) && hit < 200) {
    hit++;
    const time = sanitize(m[1]);
    const location = sanitize(m[2]);
    const status = sanitize(m[3]);
    const memo = sanitize(m[4]);
    if (time || location || status || memo) {
      history.push({
        time: toIsoIfPossible(time),
        location,
        status,
        memo,
      });
    }
  }

  // 5) 보정 로직
  let originFromHistory = null;
  let destFromHistory = null;

  for (const row of history) {
    const t = (row.time || "").toString();
    const s = row.status || "";
    const memo = row.memo || "";
    const loc = row.location || "";

    if (!originFromHistory && /집하지점/.test(t)) originFromHistory = loc;
    if (!destFromHistory && (/배송지점/.test(s) || /배송지점/.test(t))) destFromHistory = memo || loc;
  }

  if (originFromHistory) origin = originFromHistory;
  if (destFromHistory) destination = destFromHistory;

  // 6) 이벤트 기반 상태 보정
  const EVENT_RE =
    /(배송완료|배달완료|배송출고|배달출고|배송출발|배달출발|터미널입고|터미널 출고|터미널출고|행낭|간선상차|간선하차|집하)/;

  let eventRow = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const st = history[i].status || "";
    if (EVENT_RE.test(st)) {
      eventRow = history[i];
      break;
    }
  }

  if (!rawStatus && eventRow && eventRow.status) rawStatus = eventRow.status;
  if (!lastEventAtRaw && eventRow && eventRow.time) lastEventAtRaw = eventRow.time;

  return {
    invoice,
    carrier: "LOGEN",
    standardStatus: toStandardStatus(rawStatus),
    rawStatus: rawStatus || null,
    lastEventAt: toIsoIfPossible(lastEventAtRaw),
    origin,
    destination,
    trackUrl: buildTrackUrl(invoice),
    error: null,
    history,
  };
}

// ---------- 메인 핸들러 (Vercel Serverless Function) ----------

export default async function handler(req, res) {
  // 1. CORS 설정 (프론트엔드와 백엔드가 같은 도메인이면 생략 가능하나, 안전을 위해 유지)
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  // OPTIONS 요청 처리
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // GET /api/track 처리
  if (req.method === "GET") {
    const { invoices: param } = req.query;
    const invoices = Array.from(new Set(parseInvoices(param)));

    if (!invoices.length) {
      return res.status(422).json({ error: "no invoices" });
    }

    // Vercel Hobby(무료) TimeLimit: 10초 / Pro: 60초
    // 직렬(for loop) 대신 병렬(Promise.all) 처리로 속도 향상 필요
    // 단, 너무 많은 동시 요청은 IP 차단 위험이 있으므로 주의 (여기선 10초 제한 회피가 우선)
    const timeoutMs = 8000; // 안전 마진 고려 8초

    const tasks = invoices.map(async (inv) => {
      try {
        const html = await fetchLogenHtml(inv, timeoutMs);
        const item = parseLogenHtml(inv, html);
        if (!item.rawStatus) {
          item.error = "조회 결과가 없습니다.";
        }
        return item;
      } catch (e) {
        return {
          invoice: inv,
          carrier: "LOGEN",
          standardStatus: "UNKNOWN",
          trackUrl: buildTrackUrl(inv),
          error: String(e),
        };
      }
    });

    const results = await Promise.all(tasks);
    
    const hasError = results.some((r) => r.error);
    // 부분 성공 시 207, 전체 실패 시 502, 성공 시 200 (선택사항, 여기선 200으로 통일해도 무방)
    return res.status(200).json(results);
  }

  // 그 외 메서드
  return res.status(405).json({ error: "Method Not Allowed" });
}
