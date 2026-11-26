/**
 * Domain, DNS and email-security intelligence: the organizational domain, SPF / DMARC / DKIM / MX
 * analysis, DNSSEC, RDAP registration data and the TLS certificate. DNS goes over Cloudflare's
 * DNS-over-HTTPS JSON API so it works the same on Node and Workers.
 *
 * Email records belong to the organizational domain (example.co.uk), not the web host
 * (www.example.co.uk): SPF and MX are read there, and DMARC is read at the host first and then at the
 * organizational domain, as RFC 7489 §6.6.3 describes.
 */
import { UA, isIpLiteral, resolvesToPublic } from "./net.js";

// Public suffixes with more than one label (a practical subset of the Public Suffix List), plus hosting
// platforms where every subdomain belongs to a different owner.
const MULTI_LABEL_SUFFIXES = new Set(`
co.uk org.uk ac.uk gov.uk ltd.uk plc.uk me.uk net.uk sch.uk nhs.uk police.uk
co.in net.in org.in firm.in gen.in ind.in ac.in edu.in res.in gov.in nic.in
com.au net.au org.au edu.au gov.au asn.au id.au co.nz net.nz org.nz govt.nz ac.nz
co.za org.za gov.za ac.za net.za com.br net.br org.br gov.br com.mx org.mx gob.mx net.mx
co.jp ne.jp or.jp ac.jp go.jp com.sg edu.sg gov.sg org.sg net.sg com.my net.my org.my gov.my edu.my
com.pk org.pk net.pk edu.pk gov.pk com.bd org.bd net.bd edu.bd gov.bd com.np org.np com.lk org.lk
co.id or.id ac.id go.id web.id com.ph org.ph net.ph com.vn co.th or.th ac.th in.th co.kr or.kr
com.cn net.cn org.cn gov.cn com.hk org.hk net.hk edu.hk gov.hk com.tw org.tw com.tr org.tr net.tr
co.il org.il ac.il com.sa net.sa org.sa co.ae net.ae org.ae gov.ae com.eg com.ng org.ng com.gh co.ke or.ke
co.ug co.tz com.ar com.co com.pe com.ec com.ve com.uy com.es org.es co.at or.at com.pl net.pl org.pl com.ua
github.io gitlab.io vercel.app netlify.app pages.dev workers.dev herokuapp.com blogspot.com wordpress.com
wixsite.com web.app firebaseapp.com azurewebsites.net cloudfront.net appspot.com onrender.com fly.dev
myshopify.com surge.sh glitch.me replit.app framer.website webflow.io carrd.co
`.trim().split(/\s+/));

/** The registrable ("organizational") domain of a host: www.shop.example.co.uk -> example.co.uk. Null for IPs. */
export function organizationalDomain(host) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!h || isIpLiteral(h)) return null;
  const labels = h.split(".");
  if (labels.length < 2) return null;
  for (let n = Math.min(labels.length - 1, 3); n >= 2; n--) {
    if (MULTI_LABEL_SUFFIXES.has(labels.slice(-n).join("."))) return labels.slice(-(n + 1)).join(".");
  }
  return labels.slice(-2).join(".");
}

// ─── DNS over HTTPS ───────────────────────────────────────────────────────────

const TYPES = { A: 1, NS: 2, CNAME: 5, SOA: 6, MX: 15, TXT: 16, AAAA: 28, DS: 43 };

/**
 * One DNS question. { ok, nxdomain, answers: [{ type, data }] }. ok is false when the resolver
 * couldn't answer (timeout, SERVFAIL), which callers report as "not measured", never as "missing".
 */
export async function dnsQuery(name, type, ms = 4000) {
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(ms) });
    if (!r.ok) return { ok: false, nxdomain: false, answers: [] };
    const j = await r.json();
    // Status 0 = NOERROR, 3 = NXDOMAIN (the name doesn't exist: a definite "no record").
    if (j.Status !== 0 && j.Status !== 3) return { ok: false, nxdomain: false, answers: [] };
    const answers = (j.Answer || []).filter(a => a.type === TYPES[type]).map(a => ({ type: a.type, data: String(a.data) }));
    return { ok: true, nxdomain: j.Status === 3, answers };
  } catch {
    return { ok: false, nxdomain: false, answers: [] };
  }
}

/** A TXT answer's text: quoted chunks are joined (long records are split into 255-byte strings). */
export function txtValue(data) {
  const chunks = String(data).match(/"((?:[^"\\]|\\.)*)"/g);
  return chunks ? chunks.map(c => c.slice(1, -1).replace(/\\(.)/g, "$1")).join("") : String(data);
}

async function txtRecords(name) {
  const r = await dnsQuery(name, "TXT");
  return { ok: r.ok, values: r.answers.map(a => txtValue(a.data)) };
}

// ─── SPF (RFC 7208) ───────────────────────────────────────────────────────────

const isSpf = v => /^v=spf1(\s|$)/i.test(v.trim());
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9_%{}+-](?:[a-z0-9_%{}+.-]{0,61}[a-z0-9_%{}])?\.)+[a-z0-9_%{}-]{1,63}\.?$/i;
const IP4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** Parses one SPF record into mechanisms, modifiers and syntax errors. */
export function parseSpf(record) {
  const terms = String(record).trim().split(/\s+/);
  const out = { mechanisms: [], redirect: null, all: null, errors: [] };
  if (!terms.length || terms[0].toLowerCase() !== "v=spf1") out.errors.push("The record must start with v=spf1.");
  for (const term of terms.slice(1)) {
    const mod = term.match(/^([a-z][a-z0-9_.-]*)=(.*)$/i);
    if (mod) {
      const name = mod[1].toLowerCase();
      if (name === "redirect") {
        if (out.redirect) out.errors.push("redirect= appears more than once.");
        if (!DOMAIN_RE.test(mod[2])) out.errors.push(`redirect=${mod[2]} is not a valid domain.`);
        out.redirect = mod[2].toLowerCase();
      }
      continue; // exp= and unknown modifiers are allowed
    }
    const m = term.match(/^([+\-~?]?)([a-z0-9]+)(?::([^/]*))?((?:\/\d{1,3})?(?:\/\/\d{1,3})?)$/i);
    if (!m) { out.errors.push(`"${term}" is not a valid SPF term.`); continue; }
    const [, q, rawType, value = null, cidr] = m;
    const type = rawType.toLowerCase();
    const qualifier = q || "+";
    const bad = msg => out.errors.push(msg);
    switch (type) {
      case "all":
        if (value !== null || cidr) bad(`"${term}": all takes no value.`);
        if (out.all) bad("all appears more than once.");
        out.all = qualifier;
        break;
      case "include": case "exists":
        if (!value || !DOMAIN_RE.test(value)) bad(`"${term}": ${type} needs a domain.`);
        break;
      case "a": case "mx": case "ptr":
        if (value !== null && !DOMAIN_RE.test(value)) bad(`"${term}": "${value}" is not a valid domain.`);
        break;
      case "ip4": {
        const bits = cidr ? Number(cidr.slice(1)) : 32;
        if (!value || !IP4_RE.test(value) || bits > 32) bad(`"${term}" is not a valid IPv4 address or range.`);
        break;
      }
      case "ip6":
        if (!value || !value.includes(":") || (cidr && Number(cidr.replace(/^\/+/, "")) > 128)) bad(`"${term}" is not a valid IPv6 address or range.`);
        break;
      default:
        bad(`"${term}": "${type}" is not an SPF mechanism.`);
    }
    out.mechanisms.push({ qualifier, type, value: value?.toLowerCase() ?? null, raw: term });
  }
  return out;
}

const LOOKUP_TYPES = new Set(["include", "a", "mx", "ptr", "exists"]);

/**
 * Counts the DNS lookups an SPF check needs (RFC 7208 §4.6.4 allows 10), following include: and
 * redirect= targets. `resolveTxt(name)` returns { ok, values }. `root` is the domain the record belongs
 * to (so an include loop back to it is caught). Stops after 30 queries.
 */
export async function countSpfLookups(parsed, resolveTxt, root = null) {
  const state = { lookups: 0, queries: 0, seen: new Set(root ? [root] : []), problems: [], tree: [] };
  const walk = async (p, depth) => {
    if (depth > 10) { state.problems.push("SPF includes are nested more than 10 levels deep."); return; }
    const follow = async (domain, via) => {
      if (state.seen.has(domain)) { state.problems.push(`${domain} is included more than once (a loop or duplicate).`); return; }
      state.seen.add(domain);
      if (state.queries >= 30) return;
      state.queries++;
      const txt = await resolveTxt(domain);
      if (!txt.ok) { state.tree.push({ domain, via, records: null }); return; }
      const records = txt.values.filter(isSpf);
      state.tree.push({ domain, via, records: records.length });
      if (records.length !== 1) {
        state.problems.push(records.length ? `${domain} (from ${via}) publishes ${records.length} SPF records.` : `${domain} (from ${via}) has no SPF record, so this ${via} fails.`);
        return;
      }
      await walk(parseSpf(records[0]), depth + 1);
    };
    for (const m of p.mechanisms) {
      if (!LOOKUP_TYPES.has(m.type)) continue;
      state.lookups++;
      if (m.type === "include") await follow(m.value, "include");
    }
    if (p.redirect && !p.all) { state.lookups++; await follow(p.redirect, "redirect"); }
  };
  await walk(parsed, 0);
  return state;
}

// ─── email providers (identified only from evidence: MX hosts or SPF includes) ─

const PROVIDERS = [
  { name: "Google Workspace", mx: /(^|\.)(aspmx\.l\.google\.com|smtp\.google\.com|googlemail\.com)\.?$/, spf: /^_spf\.google\.com$/, include: () => "_spf.google.com", dkim: "google" },
  { name: "Microsoft 365", mx: /\.mail\.protection\.outlook\.com\.?$/, spf: /^spf\.protection\.outlook\.com$/, include: () => "spf.protection.outlook.com", dkim: "selector1" },
  { name: "Zoho Mail", mx: /(^|\.)zoho\.(com|in|eu|com\.au)\.?$/, spf: /^(zoho\.(com|in|eu|com\.au)|zcsend\.net)$/, include: mx => (mx.match(/zoho\.(com\.au|com|in|eu)/)?.[0] || "zoho.com"), dkim: "zmail" },
  { name: "Titan Email", mx: /(^|\.)titan\.email\.?$/, spf: /^spf\.titan\.email$/, include: () => "spf.titan.email" },
  { name: "GoDaddy Email", mx: /(^|\.)secureserver\.net\.?$/, spf: /^secureserver\.net$/, include: () => "secureserver.net" },
  { name: "Hostinger Email", mx: /(^|\.)hostinger\.(com|in)\.?$/, spf: /^_spf\.mail\.hostinger\.com$/, include: () => "_spf.mail.hostinger.com" },
  { name: "Cloudflare Email Routing", mx: /\.mx\.cloudflare\.net\.?$/, spf: /^_spf\.mx\.cloudflare\.net$/, include: () => "_spf.mx.cloudflare.net" },
  { name: "Fastmail", mx: /(^|\.)messagingengine\.com\.?$/, spf: /^spf\.messagingengine\.com$/, include: () => "spf.messagingengine.com", dkim: "fm1" },
  { name: "Proton Mail", mx: /(^|\.)protonmail\.ch\.?$/, spf: /^_spf\.protonmail\.ch$/, include: () => "_spf.protonmail.ch", dkim: "protonmail" },
];
const SENDERS = [
  ["Amazon SES", /amazonses\.com$/], ["SendGrid", /sendgrid\.net$/], ["Mailgun", /mailgun\.org$/],
  ["Mailchimp", /(servers\.mcsv\.net|spf\.mandrillapp\.com)$/], ["Brevo", /(sendinblue\.com|brevo\.com)$/],
  ["Postmark", /spf\.mtasv\.net$/], ["HubSpot", /hubspotemail\.net$/], ["Zendesk", /mail\.zendesk\.com$/],
  ["Salesforce", /_spf\.salesforce\.com$/],
];

/** The mailbox provider shown by the MX records (preferred) or the SPF includes, or null if there's no evidence. */
export function identifyProvider(mxHosts, spfIncludes) {
  for (const p of PROVIDERS) {
    const mx = mxHosts.find(h => p.mx.test(h));
    if (mx) return { name: p.name, via: "mx", evidence: mx, include: p.include(mx), dkim: p.dkim || null };
  }
  for (const p of PROVIDERS) {
    const inc = spfIncludes.find(d => p.spf.test(d));
    if (inc) return { name: p.name, via: "spf", evidence: `include:${inc}`, include: inc, dkim: p.dkim || null };
  }
  return null;
}

export function identifySenders(spfIncludes) {
  return SENDERS.filter(([, re]) => spfIncludes.some(d => re.test(d))).map(([name]) => name);
}

// ─── DMARC (RFC 7489) ─────────────────────────────────────────────────────────

export function parseDmarc(record) {
  const tags = {};
  const errors = [];
  const parts = String(record).split(";").map(s => s.trim()).filter(Boolean);
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i < 1) { errors.push(`"${p}" is not a tag=value pair.`); continue; }
    tags[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim();
  }
  if (!/^DMARC1$/i.test(tags.v || "") || !/^v\s*=/i.test(parts[0] || "")) errors.push("The record must start with v=DMARC1.");
  const policy = (tags.p || "").toLowerCase();
  if (!["none", "quarantine", "reject"].includes(policy)) errors.push(tags.p ? `p=${tags.p} is not none, quarantine or reject.` : "The required p= tag is missing.");
  const pct = tags.pct === undefined ? 100 : Number(tags.pct);
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) errors.push(`pct=${tags.pct} must be a whole number from 0 to 100.`);
  return {
    policy: ["none", "quarantine", "reject"].includes(policy) ? policy : null,
    subdomain_policy: (tags.sp || "").toLowerCase() || null,
    pct: Number.isInteger(pct) ? pct : null,
    rua: tags.rua || null, ruf: tags.ruf || null,
    adkim: (tags.adkim || "r").toLowerCase(), aspf: (tags.aspf || "r").toLowerCase(),
    errors,
  };
}

// Common DKIM selectors. DKIM can only be confirmed for a selector we know; finding none proves nothing.
const DKIM_SELECTORS = ["google", "selector1", "selector2", "default", "k1", "s1", "s2", "dkim", "mail", "zmail", "zoho", "resend", "protonmail", "fm1", "hs1", "mandrill"];
// Selectors that identify the service signing the mail (evidence for "who sends as you").
const DKIM_SENDERS = { google: "Google Workspace", selector1: "Microsoft 365", selector2: "Microsoft 365", k1: "Mailchimp", mandrill: "Mailchimp Transactional",
  s1: "SendGrid", s2: "SendGrid", zmail: "Zoho Mail", zoho: "Zoho Mail", resend: "Resend", protonmail: "Proton Mail", fm1: "Fastmail", hs1: "HubSpot" };
// Subdomains transactional senders use as the envelope sender (Return-Path), where their SPF lives.
const SENDING_SUBDOMAINS = ["send", "bounce", "bounces", "mail", "email", "mg", "em", "mta"];

/**
 * Everything about the domain's email authentication. `dns` defaults to DNS-over-HTTPS; tests pass a fake.
 * Returns { domain, host, mx, spf, dmarc, dkim, provider, senders } — every part has its own `measured` flag.
 */
export async function analyzeEmail(host, { dns = dnsQuery } = {}) {
  const domain = organizationalDomain(host);
  if (!domain) return null;
  const txt = async name => { const r = await dns(name, "TXT"); return { ok: r.ok, values: r.answers.map(a => txtValue(a.data)) }; };
  const hostName = host.toLowerCase();
  const [root, mxRes, dmarcOrg, dmarcHost] = await Promise.all([txt(domain), dns(domain, "MX"), txt(`_dmarc.${domain}`), hostName !== domain ? txt(`_dmarc.${hostName}`) : null]);
  const dkimRes = await Promise.all(DKIM_SELECTORS.map(s => txt(`${s}._domainkey.${domain}`)));

  const mx = mxRes.answers.map(a => { const [pri, ...h] = a.data.split(/\s+/); return { priority: Number(pri), host: h.join(" ").replace(/\.$/, "").toLowerCase() }; })
    .sort((a, b) => a.priority - b.priority);

  // SPF
  const spfRecords = root.values.filter(isSpf);
  const spf = { measured: root.ok, domain, records: spfRecords, parsed: null, lookups: null, problems: [] };
  if (spfRecords.length === 1) {
    spf.parsed = parseSpf(spfRecords[0]);
    const count = await countSpfLookups(spf.parsed, txt, domain);
    spf.lookups = count.lookups;
    spf.problems = count.problems;
    spf.includes = spf.parsed.mechanisms.filter(m => m.type === "include").map(m => m.value);
    spf.tree = count.tree;
  } else {
    spf.includes = spfRecords.flatMap(r => parseSpf(r).mechanisms.filter(m => m.type === "include").map(m => m.value));
  }
  // No SPF on the root: transactional senders (Resend, Mailgun, SES...) put SPF on a sending subdomain instead.
  if (spf.measured && !spfRecords.length) {
    const subs = await Promise.all(SENDING_SUBDOMAINS.map(async s => ({ name: `${s}.${domain}`, spf: (await txt(`${s}.${domain}`)).values.filter(isSpf) })));
    spf.subdomains = subs.filter(s => s.spf.length).map(s => ({ name: s.name, record: s.spf[0] }));
  }

  // DMARC for mail from @domain lives at _dmarc.<organizational domain> (RFC 7489 §6.6.3). A record that
  // exists only at _dmarc.www... covers @www addresses, not the business's real email domain.
  const isDmarc = v => /^v\s*=\s*DMARC1/i.test(v.trim());
  const orgRecs = dmarcOrg.values.filter(isDmarc);
  const hostRecs = dmarcHost ? dmarcHost.values.filter(isDmarc) : [];
  const dmarc = { measured: dmarcOrg.ok, records: orgRecs, domain, parsed: orgRecs.length === 1 ? parseDmarc(orgRecs[0]) : null,
    host_record: hostRecs[0] || null, host_domain: hostRecs.length ? hostName : null };

  const dkimFound = DKIM_SELECTORS.filter((s, i) => dkimRes[i].values.some(v => /(^|;)\s*(v=DKIM1|k=|p=)/i.test(v)));
  const provider = identifyProvider(mx.map(m => m.host), spf.includes || []);
  const subIncludes = (spf.subdomains || []).flatMap(s => parseSpf(s.record).mechanisms.filter(m => m.type === "include").map(m => m.value));
  return {
    domain, host: hostName, checked_at: new Date().toISOString(),
    mx: { measured: mxRes.ok, records: mx },
    spf, dmarc,
    dkim: { measured: dkimRes.some(r => r.ok), selectors_probed: DKIM_SELECTORS, selectors_found: dkimFound },
    provider,
    senders: [...new Set([...identifySenders([...(spf.includes || []), ...subIncludes]), ...dkimFound.map(s => DKIM_SENDERS[s]).filter(Boolean)])],
  };
}

// ─── DNSSEC, RDAP, TLS ────────────────────────────────────────────────────────

/** true / false when DNSSEC is (not) set up at the parent, null if it couldn't be checked. */
export async function dnssecSigned(domain, rdap, { dns = dnsQuery } = {}) {
  if (typeof rdap?.secureDNS?.delegationSigned === "boolean") return { signed: rdap.secureDNS.delegationSigned, source: "rdap" };
  const ds = await dns(domain, "DS");
  return ds.ok ? { signed: ds.answers.length > 0, source: "dns" } : { signed: null, source: null };
}

/** RDAP registration data for the registrable domain via the rdap.org bootstrap, summarised; null if unavailable. */
export async function domainRegistration(domain, ms = 8000) {
  if (!domain) return null;
  let j;
  try {
    const r = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`,
      { headers: { accept: "application/rdap+json, application/json", "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    j = await r.json();
  } catch { return null; }
  if (!j?.events) return null;
  const ev = action => j.events.find(e => e.eventAction === action)?.eventDate ?? null;
  const expires = ev("expiration"), created = ev("registration");
  const registrar = j.entities?.find(e => e.roles?.includes("registrar"));
  return {
    domain,
    registrar: registrar?.vcardArray?.[1]?.find?.(v => v[0] === "fn")?.[3] ?? null,
    created, expires,
    days_left: expires ? Math.round((new Date(expires) - Date.now()) / 864e5) : null,
    age_years: created ? Math.floor((Date.now() - new Date(created)) / (365.25 * 864e5)) : null,
    nameservers: (j.nameservers || []).map(ns => ns.ldhName?.toLowerCase()).filter(Boolean).slice(0, 6),
    status: Array.isArray(j.status) ? j.status.slice(0, 6) : [],
    dnssec: typeof j.secureDNS?.delegationSigned === "boolean" ? j.secureDNS.delegationSigned : null,
    source: "rdap.org",
    secureDNS: j.secureDNS,
  };
}

/**
 * The site's TLS certificate (Node only; null on runtimes without node:tls or when the handshake fails).
 * Connects only after the host resolves to a public address.
 */
export async function tlsCertificate(host, ms = 6000) {
  if (isIpLiteral(host) || !(await resolvesToPublic(host))) return null;
  let tls;
  try { tls = await import("node:tls"); } catch { return null; }
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    let socket;
    try {
      socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: ms }, () => {
        const c = socket.getPeerCertificate();
        const validTo = c?.valid_to ? new Date(c.valid_to) : null;
        finish({
          valid_from: c?.valid_from ? new Date(c.valid_from).toISOString() : null,
          valid_to: validTo ? validTo.toISOString() : null,
          days_left: validTo ? Math.floor((validTo - Date.now()) / 864e5) : null,
          issuer: c?.issuer?.O || c?.issuer?.CN || null,
          subject: c?.subject?.CN || null,
          authorized: socket.authorized,
          error: socket.authorized ? null : String(socket.authorizationError || "untrusted"),
          protocol: socket.getProtocol?.() || null,
        });
        socket.end();
      });
    } catch { return finish(null); }
    socket.on("error", () => finish(null));
    socket.on("timeout", () => { socket.destroy(); finish(null); });
  });
}
