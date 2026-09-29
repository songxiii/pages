import { ticketFromLocation } from "./ticket.js";

const result = document.getElementById("result");
const ticket = ticketFromLocation(window.location)?.value;

if (!ticket) {
  result.textContent = "缺少 ticket 参数";
} else {
  try {
    const response = await fetch("https://springboot-thzo-281960-9-1453811837.sh.run.tcloudbase.com/api/activity-webview/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      body: JSON.stringify({ ticket }),
    });
    const body = await response.text();
    try {
      result.textContent = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      result.textContent = body || `请求失败（HTTP ${response.status}）`;
    }
  } catch (error) {
    result.textContent = `请求失败：${error.message}`;
  }
}
