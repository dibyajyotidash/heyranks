/* HeyRanks visit counter for public pages (shown in Admin → Visitors). No cookies: the session id lives
   in sessionStorage and ends when the tab closes. The server stores no IP address. */
(() => {
  let sid = null;
  try {
    sid = sessionStorage.getItem("hr_sid");
    if (!sid) { sid = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/[^A-Za-z0-9]/g, "").slice(0, 24); sessionStorage.setItem("hr_sid", sid); }
  } catch { /* private mode: count the visit without a session */ }
  const q = new URLSearchParams(location.search);
  let timezone = null;
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
  fetch("/api/track", {
    method: "POST", keepalive: true, headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: location.pathname, referrer: document.referrer, session_id: sid,
      utm_source: q.get("utm_source"), utm_medium: q.get("utm_medium"), utm_campaign: q.get("utm_campaign"),
      screen_width: screen.width, language: navigator.language, timezone,
    }),
  }).catch(() => {});
})();
