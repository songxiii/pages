(function () {
  function readTicket(part) {
    var match = /(?:^|&)ticket(?:=([^&]*))?(?:&|$)/.exec(part);
    return match ? decodeURIComponent((match[1] || "").replace(/\+/g, " ")) : null;
  }

  var result = document.getElementById("result");
  var ticket = readTicket(window.location.search.slice(1));
  if (ticket === null) ticket = readTicket(window.location.hash.slice(1));

  if (!ticket) {
    result.textContent = "缺少 ticket 参数";
    return;
  }

  var request = new XMLHttpRequest();
  request.open("POST", "https://springboot-thzo-281960-9-1453811837.sh.run.tcloudbase.com/api/activity-webview/resolve", true);
  request.withCredentials = false;
  request.setRequestHeader("Content-Type", "application/json");
  request.onload = function () {
    var body = request.responseText;
    try {
      result.textContent = JSON.stringify(JSON.parse(body), null, 2);
    } catch (error) {
      result.textContent = body || "请求失败（HTTP " + request.status + "）";
    }
  };
  request.onerror = function () {
    result.textContent = "请求失败：网络连接或跨域访问受阻";
  };
  request.send(JSON.stringify({ ticket: ticket }));
})();
