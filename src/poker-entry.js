export function ticketFromLocation(location) {
  const query = new URLSearchParams(location.search || "");
  const fragment = new URLSearchParams((location.hash || "").replace(/^#/, ""));
  return query.get("ticket") || fragment.get("ticket") || "";
}

export function ticketFragmentUrl(location) {
  const ticket = ticketFromLocation(location);
  if (!ticket) return null;
  const url = new URL(location.href);
  if (!url.searchParams.has("ticket")) return null;
  url.searchParams.delete("ticket");
  url.hash = "ticket=" + encodeURIComponent(ticket);
  return url.pathname + url.search + url.hash;
}
