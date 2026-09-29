(function () {
  function readTicket(part) {
    var match = /(?:^|&)ticket(?:=([^&]*))?(?:&|$)/.exec(part);
    return match ? decodeURIComponent((match[1] || "").replace(/\+/g, " ")) : null;
  }

  var result = document.getElementById("result");
  var profile = document.getElementById("profile");
  var avatar = document.getElementById("avatar");
  var avatarFallback = document.getElementById("avatar-fallback");
  var userName = document.getElementById("user-name");
  var activityId = document.getElementById("activity-id");
  var ticket = readTicket(window.location.search.slice(1));
  if (ticket === null) ticket = readTicket(window.location.hash.slice(1));

  function showProfile(response) {
    if (!response || response.code !== 0 || !response.data || typeof response.data !== "object") return;

    var data = response.data;
    var name = data.username ? String(data.username) : "未提供姓名";
    userName.textContent = name;
    activityId.textContent = data.activityId == null || data.activityId === "" ? "未提供" : String(data.activityId);
    avatarFallback.textContent = name.charAt(0) || "人";
    profile.hidden = false;

    if (typeof data.avatarUrl === "string" && /^https?:\/\//i.test(data.avatarUrl)) {
      avatar.alt = name + "的头像";
      avatar.onload = function () {
        avatar.hidden = false;
        avatarFallback.hidden = true;
      };
      avatar.src = data.avatarUrl;
    }
  }

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
      var response = JSON.parse(body);
      result.textContent = JSON.stringify(response, null, 2);
      showProfile(response);
    } catch (error) {
      result.textContent = body || "请求失败（HTTP " + request.status + "）";
    }
  };
  request.onerror = function () {
    result.textContent = "请求失败：网络连接或跨域访问受阻";
  };
  request.send(JSON.stringify({ ticket: ticket }));
})();
