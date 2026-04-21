const TOKEN_SAFETY_BUFFER_MS = 5 * 60 * 1000;
const SESSION_COOKIE = "erp_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const KINGDEE_TIME_ZONE = "Asia/Shanghai";

let tokenCache = {
  accessToken: "",
  expireAt: 0,
};

export async function onRequestPost(context) {
  try {
    const body = await readJson(context.request);
    const action = String(body.action || "").trim();

    if (!action) {
      return json({ success: false, message: "缺少 action 参数。" }, 400);
    }

    switch (action) {
      case "session":
        return handleSession(context);
      case "login":
        return handleLogin(context, body);
      case "logout":
        return handleLogout();
      case "query":
        return handleQuery(context, body);
      case "abort":
        return handleAbort(context, body);
      default:
        return json({ success: false, message: "不支持的操作。" }, 400);
    }
  } catch (error) {
    return json(
      { success: false, message: error.message || "服务异常，请稍后再试。" },
      error instanceof HttpError ? error.status : 500
    );
  }
}

async function handleSession(context) {
  return json({ success: true, authenticated: await isAuthenticated(context) });
}

async function handleLogin(context, body) {
  assertEnv(context.env, [
    "APP_PASSWORD_HASH",
    "APP_PASSWORD_SALT",
    "SESSION_SECRET",
  ]);

  const password = String(body.password || "").trim();
  if (!password) {
    return json({ success: false, message: "请输入访问密码。" }, 400);
  }

  const expectedHash = normalizeHex(context.env.APP_PASSWORD_HASH);
  const actualHash = await sha256Hex(`${context.env.APP_PASSWORD_SALT}:${password}`);

  if (!timingSafeEqual(expectedHash, actualHash)) {
    return json({ success: false, message: "密码错误，请重试。" }, 401);
  }

  const token = await signSessionToken(context.env.SESSION_SECRET);

  return json(
    { success: true, message: "登录成功。", authenticated: true },
    200,
    {
      "Set-Cookie": buildSessionCookie(token, SESSION_TTL_SECONDS),
    }
  );
}

async function handleLogout() {
  return json(
    { success: true, message: "已退出登录。", authenticated: false },
    200,
    {
      "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    }
  );
}

async function handleQuery(context, body) {
  await requireAuth(context);
  assertKingdeeEnv(context.env);

  const billNo = String(body.billNo || "").trim();
  if (!billNo) {
    return json({ success: false, message: "请输入单据编号。" }, 400);
  }

  const result = await getProcessInstance(context.env, billNo);
  if (!result.found) {
    return json({ success: false, message: result.message }, 404);
  }

  return json({
    success: true,
    data: {
      billNo: result.billNo,
      processInstanceId: result.processInstanceId,
      title: result.title,
      companyName: result.companyName,
      docType: result.docType,
      state: result.state,
      suspensionState: result.suspensionState,
      startUser: result.startUser,
      currentHandler: result.currentHandler,
    },
  });
}

async function handleAbort(context, body) {
  await requireAuth(context);
  assertKingdeeEnv(context.env);

  const processInstanceId = String(body.processInstanceId || "").trim();
  if (!processInstanceId) {
    return json({ success: false, message: "缺少流程实例 ID。" }, 400);
  }

  const result = await abortProcess(context.env, processInstanceId);
  if (!result.success) {
    return json({ success: false, message: result.message }, 400);
  }

  return json(result);
}

async function getProcessInstance(env, billNo) {
  const url = `${stripTrailingSlash(env.KINGDEE_API_URL)}/ierp/kapi/v2/ctjt/wf/wf_execution/query`;
  const payload = {
    data: { billno: billNo },
    pageNo: 1,
    pageSize: 10,
  };

  try {
    const result = await requestKingdee(env, url, payload);
    const rows = result?.data?.rows || [];

    if (!Array.isArray(rows) || rows.length === 0) {
      return { found: false, message: "未查询到该单据对应的流程实例。" };
    }

    const row = rows[0];
    const startUserRaw = String(row.starusernameformat || "");
    const suspensionStateCode = Number(row.suspensionstate || 0);
    const title = String(row.subject || row.name || "未知流程");
    const summary = parseProcessSummary(title, billNo);

    return {
      found: true,
      billNo,
      processInstanceId: String(row.processinstanceid || ""),
      title,
      companyName: summary.companyName,
      docType: summary.docType,
      state: row.active ? "运行中" : "已结束",
      suspensionState:
        suspensionStateCode === 1
          ? "正常运行"
          : suspensionStateCode === 2
            ? "已挂起"
            : "未知状态",
      startUser: startUserRaw.split("|")[0] || "未知发起人",
      currentHandler: String(row.presentassignee || "暂无"),
    };
  } catch (error) {
    return { found: false, message: error.message || "查询失败，请稍后再试。" };
  }
}

async function abortProcess(env, processInstanceId) {
  const url = `${stripTrailingSlash(env.KINGDEE_API_URL)}/ierp/kapi/v2/wf/abortProcessInstance`;
  const payload = { processInstanceId };

  try {
    const result = await requestKingdee(env, url, payload);
    const data = result?.data;
    const ok = result?.status === true || (data && data.success === true);

    if (!ok) {
      return {
        success: false,
        message:
          result?.message ||
          data?.message ||
          "终止失败，第三方接口未返回明确原因。",
      };
    }

    return { success: true, message: "流程已成功终止。" };
  } catch (error) {
    return { success: false, message: error.message || "终止失败，请稍后再试。" };
  }
}

async function requestKingdee(env, url, payload) {
  let response = await sendKingdeeRequest(env, url, payload, false);
  let data = await response.json();

  if (response.status === 401 || String(data?.errorCode || "") === "401") {
    response = await sendKingdeeRequest(env, url, payload, true);
    data = await response.json();
  }

  if (!response.ok) {
    throw new Error(data?.message || `第三方接口请求失败（${response.status}）。`);
  }

  return data;
}

async function sendKingdeeRequest(env, url, payload, forceRefresh) {
  const accessToken = await getAccessToken(env, forceRefresh);

  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accessToken,
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(payload),
  });
}

async function getAccessToken(env, forceRefresh = false) {
  if (!forceRefresh && tokenCache.accessToken && Date.now() < tokenCache.expireAt) {
    return tokenCache.accessToken;
  }

  const url = `${stripTrailingSlash(env.KINGDEE_API_URL)}/ierp/kapi/oauth2/getToken`;
  const payload = {
    client_id: env.KINGDEE_CLIENT_ID,
    client_secret: env.KINGDEE_CLIENT_SECRET,
    username: env.KINGDEE_USERNAME,
    accountId: env.KINGDEE_ACCOUNT_ID,
    nonce: crypto.randomUUID(),
    timestamp: formatKingdeeTimestamp(new Date()),
    language: env.KINGDEE_LANGUAGE || "zh_CN",
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const result = await response.json();
  if (!response.ok || result?.status !== true || !result?.data?.access_token) {
    throw new Error(result?.message || "获取访问令牌失败。");
  }

  const expiresIn = Number(result.data.expires_in || 7200);
  tokenCache = {
    accessToken: String(result.data.access_token),
    expireAt: Date.now() + expiresIn * 1000 - TOKEN_SAFETY_BUFFER_MS,
  };

  return tokenCache.accessToken;
}

async function requireAuth(context) {
  const authenticated = await isAuthenticated(context);
  if (!authenticated) {
    throw new HttpError(401, "请先登录后再操作。");
  }
}

async function isAuthenticated(context) {
  const cookieHeader = context.request.headers.get("Cookie") || "";
  const sessionToken = getCookie(cookieHeader, SESSION_COOKIE);
  if (!sessionToken) {
    return false;
  }

  return verifySessionToken(sessionToken, context.env.SESSION_SECRET || "");
}

async function signSessionToken(secret) {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${expiresAt}`;
  const signature = await hmacHex(secret, payload);
  return `${payload}.${signature}`;
}

async function verifySessionToken(token, secret) {
  if (!secret) {
    return false;
  }

  const [expiresAtText, signature] = token.split(".");
  const expiresAt = Number(expiresAtText || 0);
  if (!expiresAt || !signature || Date.now() / 1000 >= expiresAt) {
    return false;
  }

  const expectedSignature = await hmacHex(secret, expiresAtText);
  return timingSafeEqual(signature, expectedSignature);
}

function buildSessionCookie(token, maxAge) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function getCookie(cookieHeader, name) {
  const items = cookieHeader.split(";");
  for (const item of items) {
    const [rawKey, ...rawValue] = item.trim().split("=");
    if (rawKey === name) {
      return rawValue.join("=");
    }
  }

  return "";
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function parseProcessSummary(title, billNo) {
  const normalizedTitle = String(title || "").replace(/\s+/g, " ").trim();
  const normalizedBillNo = String(billNo || "").trim();

  if (!normalizedTitle) {
    return { companyName: "", docType: "" };
  }

  let summary = normalizedTitle;
  if (normalizedBillNo) {
    summary = summary.replaceAll(normalizedBillNo, " ").replace(/\s+/g, " ").trim();
  }

  const cleaned = cleanupSummaryText(summary);
  const { companyName, remainder } = extractCompanyName(cleaned);
  const docType = extractDocType(remainder || cleaned);

  return {
    companyName,
    docType: docType || (!companyName ? cleaned : ""),
  };
}

function cleanupSummaryText(text) {
  return String(text || "")
    .replace(/[，,]\s*(供应商|申请人|申请金额|金额|价税合计|收款单位|客户|供应商名称|往来单位|币别)[^，,;；]*/g, "")
    .replace(/￥\s*[\d,.]+/g, "")
    .replace(/\b\d+(?:\.\d+)?\s*元\b/g, "")
    .replace(/[：:]\s*[，,]/g, " ")
    .replace(/[，,;；]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractCompanyName(text) {
  const companyPatterns = [
    /(.*?(?:有限责任公司|股份有限公司|集团有限公司|有限公司))/,
    /(.*?(?:公司))/,
  ];

  for (const pattern of companyPatterns) {
    const match = String(text || "").match(pattern);
    if (match && match[1]) {
      return {
        companyName: match[1].trim(),
        remainder: String(text).slice(match[1].length).trim(),
      };
    }
  }

  return {
    companyName: "",
    remainder: String(text || "").trim(),
  };
}

function extractDocType(text) {
  const normalized = String(text || "")
    .replace(/^[\-_/｜|:：\s]+|[\-_/｜|:：\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "";
  }

  const typePattern =
    /((?:采购|销售|付款|收款|费用|借款|请购|入库|出库|调拨|报销|付款申请|收款申请|退款|退货|生产|委外|采购退货|销售退货|发货|送货|验收|盘点|合同|订单|申请|审批|结算)[^\s，,;；]*?(?:单|订单|申请单|出库单|入库单|付款单|收款单|通知单|审批单))/;

  const match = normalized.match(typePattern);
  if (match && match[1]) {
    return match[1].trim();
  }

  return normalized
    .split(/[，,;；]/)
    .map((item) => item.trim())
    .find(Boolean) || normalized;
}

function formatKingdeeTimestamp(date) {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: KINGDEE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return bufferToHex(hash);
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );
  return bufferToHex(signature);
}

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeHex(value) {
  return String(value || "").trim().toLowerCase();
}

function timingSafeEqual(left, right) {
  const a = normalizeHex(left);
  const b = normalizeHex(right);
  if (a.length !== b.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return mismatch === 0;
}

function assertEnv(env, keys) {
  for (const key of keys) {
    if (!env[key]) {
      throw new HttpError(500, `环境变量未配置：${key}`);
    }
  }
}

function assertKingdeeEnv(env) {
  assertEnv(env, [
    "KINGDEE_API_URL",
    "KINGDEE_CLIENT_ID",
    "KINGDEE_CLIENT_SECRET",
    "KINGDEE_USERNAME",
    "KINGDEE_ACCOUNT_ID",
    "SESSION_SECRET",
  ]);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "请求体不是合法的 JSON。");
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
