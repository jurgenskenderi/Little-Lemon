/**
 * The partner console, served at /admin.
 *
 * Deliberately a single dependency-free page: adding a deal after shaking hands
 * with a restaurant should not require a build step or a separate deploy. The
 * token is held in sessionStorage so it is gone when the tab closes.
 */
export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clocktails — Partner deals</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px; background: #12100E; color: #F5F0E8;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.4px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.6px;
       color: #A79E92; margin: 32px 0 12px; }
  p.sub { color: #A79E92; margin: 0 0 24px; }
  section { background: #1D1A17; border: 1px solid #38322C; border-radius: 14px;
            padding: 20px; margin-bottom: 16px; }
  label { display: block; font-size: 13px; color: #A79E92; margin: 12px 0 4px; }
  input, select, textarea {
    width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #38322C;
    background: #12100E; color: #F5F0E8; font: inherit;
  }
  input:focus, select:focus, textarea:focus { outline: 2px solid #E8B84B; outline-offset: -1px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  button {
    margin-top: 16px; padding: 11px 18px; border-radius: 999px; border: 0;
    background: #E8B84B; color: #241E12; font-weight: 700; font-size: 14px; cursor: pointer;
  }
  button.ghost { background: transparent; color: #A79E92; border: 1px solid #38322C; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .days { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
  .days label {
    display: flex; align-items: center; gap: 6px; margin: 0; padding: 8px 12px;
    border: 1px solid #38322C; border-radius: 999px; cursor: pointer; color: #F5F0E8;
  }
  .days input { width: auto; }
  .msg { margin-top: 14px; padding: 10px 12px; border-radius: 8px; font-size: 14px; }
  .msg.ok { background: #1B3325; color: #8FE0AC; }
  .msg.err { background: #3A2020; color: #F0A0A0; }
  .venue { padding: 12px 0; border-bottom: 1px solid #38322C; }
  .venue:last-child { border-bottom: 0; }
  .venue h3 { margin: 0 0 2px; font-size: 16px; }
  .venue small { color: #7A7167; }
  .deal { margin-top: 8px; padding: 8px 12px; background: #12100E; border-radius: 8px;
          display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .tag { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #E8B84B;
         color: #241E12; font-weight: 700; }
  .tag.scraped { background: #38322C; color: #A79E92; }
  .del { background: none; border: 0; color: #F0A0A0; cursor: pointer; margin: 0;
         font-size: 13px; padding: 4px 8px; }
  code { background: #12100E; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>Partner deals</h1>
  <p class="sub">Deals entered here are marked <strong>partner</strong>: they rank above
  scraped results and a later crawl of the venue's site will never overwrite them.</p>

  <section>
    <h2 style="margin-top:0">Access</h2>
    <label for="token">Admin token (from <code>ADMIN_TOKEN</code>)</label>
    <input id="token" type="password" placeholder="Paste the token" autocomplete="off">
    <button id="connect">Connect</button>
    <div id="authMsg"></div>
  </section>

  <div id="app" hidden>
    <section>
      <h2 style="margin-top:0">1. The venue</h2>
      <p class="sub" style="margin-bottom:0">Add it once. If it is already listed below,
      skip to step 2 and pick it from the dropdown.</p>
      <label for="vName">Name</label>
      <input id="vName" placeholder="e.g. The Queen Street Tavern">
      <label for="vAddress">Address</label>
      <input id="vAddress" placeholder="e.g. 401 Queen St W">
      <div class="row3">
        <div><label for="vCity">City</label><input id="vCity" value="Toronto"></div>
        <div><label for="vRegion">Province</label><input id="vRegion" value="ON"></div>
        <div><label for="vTz">Time zone</label><input id="vTz" value="America/Toronto"></div>
      </div>
      <div class="row">
        <div><label for="vLat">Latitude</label><input id="vLat" placeholder="43.6487"></div>
        <div><label for="vLon">Longitude</label><input id="vLon" placeholder="-79.3980"></div>
      </div>
      <div class="row">
        <div><label for="vWebsite">Website</label><input id="vWebsite" placeholder="https://"></div>
        <div><label for="vPhone">Phone</label><input id="vPhone" placeholder="+1-416-555-0100"></div>
      </div>
      <button id="saveVenue">Save venue</button>
      <div id="venueMsg"></div>
    </section>

    <section>
      <h2 style="margin-top:0">2. The deal</h2>
      <label for="dVenue">Venue</label>
      <select id="dVenue"></select>
      <label for="dTitle">Title</label>
      <input id="dTitle" placeholder="e.g. Happy Hour">
      <div class="row">
        <div><label for="dPrice">Price as advertised</label>
          <input id="dPrice" placeholder="e.g. $6 pints"></div>
        <div><label for="dCategory">Applies to</label>
          <select id="dCategory">
            <option value="both">Food &amp; drinks</option>
            <option value="drink">Drinks</option>
            <option value="food">Food</option>
          </select></div>
      </div>
      <label for="dDescription">Description</label>
      <textarea id="dDescription" rows="2" placeholder="What the customer gets"></textarea>
      <label>Days</label>
      <div class="days" id="dDays"></div>
      <div class="row">
        <div><label for="dStart">Starts (24h)</label><input id="dStart" value="16:00"></div>
        <div><label for="dEnd">Ends (24h)</label><input id="dEnd" value="18:00"></div>
      </div>
      <p class="sub" style="margin:8px 0 0; font-size:13px">An end earlier than the start
      means it runs past midnight — <code>22:00</code> to <code>02:00</code> is handled correctly.</p>
      <label for="dFine">Fine print</label>
      <input id="dFine" placeholder="e.g. Bar area only, excludes holidays">
      <button id="saveDeal">Save partner deal</button>
      <div id="dealMsg"></div>
    </section>

    <section>
      <h2 style="margin-top:0">Current listings</h2>
      <div id="venueList">Loading…</div>
      <button class="ghost" id="reload">Refresh</button>
    </section>
  </div>
</main>

<script>
const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem("ct_admin_token") || "";

DAY_NAMES.forEach((name, index) => {
  const label = document.createElement("label");
  label.innerHTML = '<input type="checkbox" value="' + index + '"' +
    (index >= 1 && index <= 5 ? " checked" : "") + '>' + name;
  $("dDays").appendChild(label);
});

function show(el, ok, text) {
  el.innerHTML = '<div class="msg ' + (ok ? "ok" : "err") + '">' + text + "</div>";
}

async function api(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + token,
      ...(options && options.headers),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.details ? " " + JSON.stringify(body.details) : "";
    throw new Error((body.message || body.error || response.status) + detail);
  }
  return body;
}

async function connect() {
  token = $("token").value.trim();
  try {
    const summary = await api("/api/admin/summary");
    sessionStorage.setItem("ct_admin_token", token);
    $("app").hidden = false;
    show($("authMsg"), true,
      "Connected. " + summary.venues + " venues, " + summary.deals + " deals, " +
      summary.partnerDeals + " of them partner deals.");
    await loadVenues();
  } catch (error) {
    $("app").hidden = true;
    show($("authMsg"), false, "Could not connect: " + error.message);
  }
}

async function loadVenues() {
  const { venues } = await api("/api/admin/venues");
  const select = $("dVenue");
  select.innerHTML = venues
    .map((v) => '<option value="' + v.id + '">' + escapeHtml(v.name) + "</option>")
    .join("");

  $("venueList").innerHTML = venues.length === 0
    ? "<p class='sub'>No venues yet.</p>"
    : venues.map((v) => \`
      <div class="venue">
        <h3>\${escapeHtml(v.name)}</h3>
        <small>\${escapeHtml([v.address, v.city, v.region].filter(Boolean).join(", "))}</small>
        \${v.deals.map((d) => \`
          <div class="deal">
            <div>
              <span class="tag \${d.partner ? "" : "scraped"}">\${d.partner ? "PARTNER" : "SCRAPED"}</span>
              <strong style="margin-left:8px">\${escapeHtml(d.title)}</strong>
              <div><small>\${d.windows.map((w) => escapeHtml(w.label)).join(" · ")}</small></div>
            </div>
            <button class="del" data-deal="\${d.id}">Remove</button>
          </div>\`).join("")}
      </div>\`).join("");

  document.querySelectorAll("[data-deal]").forEach((button) => {
    button.onclick = async () => {
      if (!confirm("Remove this deal?")) return;
      await api("/api/admin/deals/" + encodeURIComponent(button.dataset.deal), { method: "DELETE" });
      await loadVenues();
    };
  });
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

$("connect").onclick = connect;
$("reload").onclick = () => loadVenues().catch((e) => show($("authMsg"), false, e.message));

$("saveVenue").onclick = async () => {
  try {
    const body = {
      name: $("vName").value.trim(),
      address: $("vAddress").value.trim() || null,
      city: $("vCity").value.trim(),
      region: $("vRegion").value.trim(),
      timeZone: $("vTz").value.trim(),
      lat: Number($("vLat").value),
      lon: Number($("vLon").value),
      website: $("vWebsite").value.trim() || null,
      phone: $("vPhone").value.trim() || null,
    };
    if (!body.name) throw new Error("Name is required.");
    if (!Number.isFinite(body.lat) || !Number.isFinite(body.lon)) {
      throw new Error("Latitude and longitude are required. Right-click the spot in Google Maps to copy them.");
    }
    const { id } = await api("/api/admin/venues", { method: "POST", body: JSON.stringify(body) });
    show($("venueMsg"), true, "Saved as " + id + ". It is now in the dropdown below.");
    await loadVenues();
    $("dVenue").value = id;
  } catch (error) {
    show($("venueMsg"), false, error.message);
  }
};

$("saveDeal").onclick = async () => {
  try {
    const days = [...document.querySelectorAll("#dDays input:checked")].map((i) => Number(i.value));
    if (days.length === 0) throw new Error("Pick at least one day.");
    const body = {
      venueId: $("dVenue").value,
      title: $("dTitle").value.trim(),
      description: $("dDescription").value.trim() || null,
      priceText: $("dPrice").value.trim() || null,
      category: $("dCategory").value,
      finePrint: $("dFine").value.trim() || null,
      days,
      start: $("dStart").value.trim(),
      end: $("dEnd").value.trim(),
    };
    if (!body.venueId) throw new Error("Add a venue first.");
    if (!body.title) throw new Error("Title is required.");
    await api("/api/admin/deals", { method: "POST", body: JSON.stringify(body) });
    show($("dealMsg"), true, "Partner deal saved. It is live in the app immediately.");
    await loadVenues();
  } catch (error) {
    show($("dealMsg"), false, error.message);
  }
};

if (token) { $("token").value = token; connect(); }
</script>
</body>
</html>`;
