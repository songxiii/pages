export function ticketFromLocation(location) {
  const query = new URLSearchParams(location.search);
  if (query.has("ticket")) return { value: query.get("ticket"), source: "query" };

  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.has("ticket")) return { value: fragment.get("ticket"), source: "fragment" };

  return null;
}
