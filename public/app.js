const endpoint = "/api/process";

const state = {
  processInstanceId: "",
};

const elements = {
  loginPanel: document.getElementById("loginPanel"),
  toolPanel: document.getElementById("toolPanel"),
  loginForm: document.getElementById("loginForm"),
  queryForm: document.getElementById("queryForm"),
  loginButton: document.getElementById("loginButton"),
  queryButton: document.getElementById("queryButton"),
  logoutButton: document.getElementById("logoutButton"),
  abortButton: document.getElementById("abortButton"),
  confirmAbortButton: document.getElementById("confirmAbortButton"),
  passwordInput: document.getElementById("passwordInput"),
  billNoInput: document.getElementById("billNoInput"),
  resultMessage: document.getElementById("resultMessage"),
  resultCard: document.getElementById("resultCard"),
  resultSummary: document.getElementById("resultSummary"),
  resultState: document.getElementById("resultState"),
  resultBillNo: document.getElementById("resultBillNo"),
  resultStartUser: document.getElementById("resultStartUser"),
  resultHandler: document.getElementById("resultHandler"),
  resultRunningState: document.getElementById("resultRunningState"),
  confirmDialog: document.getElementById("confirmDialog"),
};

function setAuthenticated(isAuthenticated) {
  elements.loginPanel.classList.toggle("hidden", isAuthenticated);
  elements.toolPanel.classList.toggle("hidden", !isAuthenticated);

  if (!isAuthenticated) {
    state.processInstanceId = "";
    elements.passwordInput.value = "";
    elements.billNoInput.value = "";
    elements.resultCard.classList.add("hidden");
  }
}

function setButtonState(button, loading, loadingText, idleText) {
  button.disabled = loading;
  button.textContent = loading ? loadingText : idleText;
}

function showMessage(type, text) {
  elements.resultMessage.className = `message is-${type}`;
  elements.resultMessage.textContent = text;
  elements.resultMessage.classList.remove("hidden");
}

function hideMessage() {
  elements.resultMessage.classList.add("hidden");
}

function clearResult() {
  state.processInstanceId = "";
  elements.resultCard.classList.add("hidden");
  elements.resultSummary.innerHTML = '<span class="result-summary-item">--</span>';
  elements.resultState.textContent = "--";
  elements.resultState.className = "status-pill";
  elements.resultBillNo.textContent = "--";
  elements.resultStartUser.textContent = "--";
  elements.resultHandler.textContent = "--";
  elements.resultRunningState.textContent = "--";
}

function renderResult(data) {
  state.processInstanceId = data.processInstanceId;
  renderResultSummary(data.title || "未知流程");
  elements.resultBillNo.textContent = data.billNo || "--";
  elements.resultStartUser.textContent = data.startUser || "--";
  elements.resultHandler.textContent = data.currentHandler || "--";
  elements.resultRunningState.textContent = data.state || "--";
  elements.resultState.textContent = data.suspensionState || data.state || "--";
  elements.resultState.className = "status-pill";

  if (elements.resultState.textContent.includes("正常")) {
    elements.resultState.classList.add("is-running");
  } else if (elements.resultState.textContent.includes("挂起")) {
    elements.resultState.classList.add("is-paused");
  }

  elements.resultCard.classList.remove("hidden");
}

function renderResultSummary(text) {
  const parts = splitSummaryText(text);
  elements.resultSummary.innerHTML = parts
    .map((part) => `<span class="result-summary-item">${escapeHtml(part)}</span>`)
    .join("");
}

function splitSummaryText(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();

  if (!normalized) {
    return ["未知流程"];
  }

  const parts = normalized
    .split(/\s+(?=[^\s：:]+[：:])/)
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length ? parts : [normalized];
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function postAction(action, payload = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    body: JSON.stringify({ action, ...payload }),
  });

  const data = await response.json().catch(() => ({
    success: false,
    message: "服务返回格式异常，请稍后重试。",
  }));

  if (!response.ok) {
    throw new Error(data.message || "请求失败");
  }

  return data;
}

async function syncSession() {
  hideMessage();
  clearResult();

  try {
    const result = await postAction("session");
    setAuthenticated(Boolean(result.authenticated));
  } catch (error) {
    setAuthenticated(false);
    showMessage("error", error.message || "登录状态校验失败");
  }
}

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideMessage();
  clearResult();

  const password = elements.passwordInput.value.trim();
  if (!password) {
    showMessage("error", "请输入访问密码。");
    return;
  }

  setButtonState(elements.loginButton, true, "登录中...", "登录并继续");

  try {
    const result = await postAction("login", { password });
    setAuthenticated(true);
    showMessage("success", result.message || "登录成功。");
  } catch (error) {
    setAuthenticated(false);
    showMessage("error", error.message || "登录失败，请重试。");
  } finally {
    setButtonState(elements.loginButton, false, "登录中...", "登录并继续");
  }
});

elements.queryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideMessage();
  clearResult();

  const billNo = elements.billNoInput.value.trim();
  if (!billNo) {
    showMessage("error", "请输入单据编号。");
    return;
  }

  setButtonState(elements.queryButton, true, "查询中...", "查询");

  try {
    const result = await postAction("query", { billNo });
    renderResult(result.data);
  } catch (error) {
    showMessage("error", error.message || "查询失败，请稍后再试。");
  } finally {
    setButtonState(elements.queryButton, false, "查询中...", "查询");
  }
});

elements.logoutButton.addEventListener("click", async () => {
  hideMessage();
  clearResult();
  setButtonState(elements.logoutButton, true, "退出中...", "退出");

  try {
    await postAction("logout");
  } catch (error) {
    showMessage("error", error.message || "退出失败，请重试。");
  } finally {
    setButtonState(elements.logoutButton, false, "退出中...", "退出");
    setAuthenticated(false);
  }
});

elements.abortButton.addEventListener("click", () => {
  if (!state.processInstanceId) {
    showMessage("error", "请先查询到有效流程。");
    return;
  }

  elements.confirmDialog.showModal();
});

elements.confirmDialog.addEventListener("close", async () => {
  if (elements.confirmDialog.returnValue !== "confirm") {
    return;
  }

  hideMessage();
  setButtonState(elements.confirmAbortButton, true, "处理中...", "确认终止");

  try {
    const result = await postAction("abort", {
      processInstanceId: state.processInstanceId,
    });
    showMessage("success", result.message || "流程已成功终止。");
    clearResult();
    elements.billNoInput.value = "";
  } catch (error) {
    showMessage("error", error.message || "终止失败，请稍后再试。");
  } finally {
    setButtonState(elements.confirmAbortButton, false, "处理中...", "确认终止");
  }
});

syncSession();
