import { POKER_API_BASE_URL } from "./poker-config.js";
import { ticketFromLocation, ticketFragmentUrl } from "./poker-entry.js";

const $ = (id) => document.getElementById(id);
const apiBase = POKER_API_BASE_URL.replace(/\/$/, "");
const ticket = ticketFromLocation(window.location);
const fragmentUrl = ticketFragmentUrl(window.location);
if (fragmentUrl) history.replaceState(null, "", fragmentUrl);

$("request-body").value = JSON.stringify({ ticket }, null, 2);

function requestDetails() {
  const token = $("access-token").value.trim().replace(/^Bearer\s+/i, "");
  const bodyText = $("request-body").value.trim();
  return {
    method: "POST",
    url: apiBase + $("endpoint").value,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.parse(bodyText),
  };
}

function renderRequest() {
  $("endpoint-url").textContent = apiBase + $("endpoint").value;
  try {
    $("request-preview").textContent = JSON.stringify(requestDetails(), null, 2);
    $("request-error").textContent = "";
  } catch {
    $("request-preview").textContent = $("request-body").value;
    $("request-error").textContent = "JSON 请求体格式不正确";
  }
}

async function sendRequest() {
  let request;
  try {
    request = requestDetails();
  } catch {
    $("request-error").textContent = "JSON 请求体格式不正确";
    return;
  }
  const button = $("send-request");
  button.disabled = true;
  $("request-error").textContent = "";
  $("response-status").textContent = "请求中…";
  $("response-status").className = "";
  $("response-body").textContent = "等待服务器返回…";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const started = performance.now();
  try {
    const response = await fetch(request.url, {
      method: request.method,
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let body;
    try { body = JSON.parse(raw); }
    catch { body = raw; }
    const elapsedMs = Math.round(performance.now() - started);
    const businessCode = body && typeof body === "object" && "code" in body ? body.code : null;
    $("response-status").textContent = "HTTP " + response.status
      + (businessCode == null ? "" : " · 业务码 " + businessCode) + " · " + elapsedMs + " ms";
    $("response-status").className = response.ok && (businessCode == null || businessCode === 0) ? "success" : "error";
    $("response-body").textContent = JSON.stringify({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }, null, 2);
  } catch (error) {
    const message = error.name === "AbortError" ? "请求超时"
      : error instanceof TypeError ? "网络请求失败或跨域访问受阻" : error.message;
    $("response-status").textContent = "请求失败";
    $("response-status").className = "error";
    $("response-body").textContent = JSON.stringify({ error: message }, null, 2);
  } finally {
    clearTimeout(timeout);
    button.disabled = false;
  }
}

$("endpoint").addEventListener("change", renderRequest);
$("access-token").addEventListener("input", renderRequest);
$("request-body").addEventListener("input", renderRequest);
$("send-request").addEventListener("click", sendRequest);
renderRequest();
