import { ticketFromLocation } from "./ticket.js";

const ticket = ticketFromLocation(window.location);

if (ticket) {
  const page = new URL("./p.html", window.location.href);
  if (ticket.source === "fragment") {
    page.hash = new URLSearchParams({ ticket: ticket.value }).toString();
  } else {
    page.searchParams.set("ticket", ticket.value);
  }
  window.location.replace(page.href);
} else {
  await import("./app.js");
}
