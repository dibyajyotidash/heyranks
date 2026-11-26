// Email security and domain intelligence. Fake DNS throughout (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { organizationalDomain, parseSpf, countSpfLookups, parseDmarc, analyzeEmail, identifyProvider, txtValue } from "../lib/domain.js";
import { runChecks } from "../lib/analysis.js";
import { presentFinding } from "../lib/catalog.js";

/** A fake DNS: zone = { "name TYPE": [data, ...] }. Every query is recorded. */
function fakeDns(zone) {
  const asked = [];
  const dns = async (name, type) => {
    asked.push(`${name} ${type}`);
    const data = zone[`${name} ${type}`] || [];
    return { ok: true, nxdomain: !data.length, answers: data.map(d => ({ type: { TXT: 16, MX: 15, DS: 43 }[type], data: d })) };
  };
  return { dns, asked };
}
const q = s => `"${s}"`;

test("organizational domain: strips subdomains and respects multi-label suffixes", () => {
  assert.equal(organizationalDomain("www.futuregain.in"), "futuregain.in");
  assert.equal(organizationalDomain("futuregain.in"), "futuregain.in");
  assert.equal(organizationalDomain("shop.www.example.co.uk"), "example.co.uk");
  assert.equal(organizationalDomain("www.example.co.in"), "example.co.in");
  assert.equal(organizationalDomain("blog.example.com.au"), "example.com.au");
  assert.equal(organizationalDomain("myapp.vercel.app"), "myapp.vercel.app", "hosting platforms: each subdomain is its own owner");
  assert.equal(organizationalDomain("93.184.216.34"), null);
});

test("CRITICAL: SPF/MX are read at the organizational domain, not at www", async () => {
  const { dns, asked } = fakeDns({
    "futuregain.in TXT": [q("v=spf1 include:_spf.google.com ~all")],
    "futuregain.in MX": ["1 smtp.google.com."],
    "_dmarc.futuregain.in TXT": [q("v=DMARC1; p=quarantine; rua=mailto:d@futuregain.in")],
    "_spf.google.com TXT": [q("v=spf1 include:_netblocks.google.com ~all")],
    "_netblocks.google.com TXT": [q("v=spf1 ip4:35.190.247.0/24 ~all")],
  });
  const e = await analyzeEmail("www.futuregain.in", { dns });
  assert.equal(e.domain, "futuregain.in");
  assert.ok(asked.includes("futuregain.in TXT"));
  assert.ok(!asked.includes("www.futuregain.in TXT"), "never looks for SPF on the www host");
  assert.equal(e.spf.records.length, 1);
  assert.equal(e.spf.lookups, 2);
  assert.equal(e.dmarc.domain, "futuregain.in", "falls back from _dmarc.www to the organizational domain");
  assert.equal(e.provider.name, "Google Workspace");

  const checks = runChecks({ host: "www.futuregain.in", org: "futuregain.in", email: e, home: { final_url: "https://www.futuregain.in/", headers: {}, page: null }, pages: [] }, "scan");
  assert.equal(checks.find(c => c.id === "spf").status, "pass");
  assert.equal(checks.find(c => c.id === "dmarc").status, "pass");
});

test("real-world shape (futuregain.in): Resend on send.<domain>, DMARC only on www", async () => {
  const { dns } = fakeDns({
    "_dmarc.www.futuregain.in TXT": [q("v=DMARC1; p=none;")],
    "resend._domainkey.futuregain.in TXT": [q("p=MIGfMA0GCSqGSIb3DQEB")],
    "send.futuregain.in TXT": [q("v=spf1 include:amazonses.com ~all")],
  });
  const e = await analyzeEmail("www.futuregain.in", { dns });
  assert.deepEqual(e.dmarc.records, [], "the www record doesn't count for @futuregain.in mail");
  assert.equal(e.dmarc.host_record, "v=DMARC1; p=none;");
  assert.deepEqual(e.spf.subdomains, [{ name: "send.futuregain.in", record: "v=spf1 include:amazonses.com ~all" }]);
  assert.ok(e.senders.includes("Resend") && e.senders.includes("Amazon SES"), "senders proven by DKIM selector and subdomain SPF");
  assert.equal(e.provider, null, "no mailbox provider is claimed without MX/SPF evidence");

  const checks = runChecks({ host: "www.futuregain.in", org: "futuregain.in", email: e, home: { final_url: "https://www.futuregain.in/", headers: {}, page: null }, pages: [] }, "scan");
  const spf = checks.find(c => c.id === "spf");
  assert.equal(spf.finding_id, "spf_root");
  assert.equal(spf.status, "warn");
  assert.equal(spf.severity, "medium", "DMARC isn't enforced yet, so this matters more");
  const ctx = { host: "www.futuregain.in", org: "futuregain.in" };
  const p = presentFinding({ check_id: "spf_root", data: spf.data }, ctx);
  assert.match(p.code, /v=spf1 -all/);
  assert.match(p.code, /send\.futuregain\.in/);
  const dmarc = checks.find(c => c.id === "dmarc");
  assert.equal(dmarc.finding_id, "dmarc_misplaced");
  assert.match(presentFinding({ check_id: "dmarc_misplaced", data: dmarc.data }, ctx).code, /Name: _dmarc\s+\(futuregain\.in\)\nv=DMARC1; p=none;/);
});

test("SPF parsing: syntax errors, qualifiers, modifiers", () => {
  const ok = parseSpf("v=spf1 ip4:203.0.113.0/24 ip6:2001:db8::/32 a mx include:_spf.google.com redirect=_spf.example.com -all");
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.all, "-");
  assert.equal(ok.redirect, "_spf.example.com");
  const bad = parseSpf("v=spf1 inlcude:_spf.google.com ip4:999.1.1.1 ~all");
  assert.equal(bad.errors.length, 2);
  assert.equal(parseSpf("v=spf1 +all").all, "+");
  assert.equal(parseSpf("v=spf1 include:x.com").all, null);
});

test("SPF lookup counting follows includes and stops at loops", async () => {
  const zone = { "a.com": "v=spf1 include:b.com include:c.com mx ~all", "b.com": "v=spf1 a include:d.com ~all", "c.com": "v=spf1 include:a.com ~all", "d.com": "v=spf1 ip4:1.2.3.4 ~all" };
  const resolve = async n => ({ ok: true, values: zone[n] ? [zone[n]] : [] });
  const r = await countSpfLookups(parseSpf(zone["a.com"]), resolve, "a.com");
  assert.equal(r.lookups, 6); // include b, include c, mx; a, include d (in b); include a (in c, not followed again)
  assert.ok(r.problems.some(p => /a\.com is included more than once/.test(p)), "the loop is reported");
  const many = `v=spf1 ${Array.from({ length: 11 }, (_, i) => `include:s${i}.example`).join(" ")} ~all`;
  const r2 = await countSpfLookups(parseSpf(many), async n => ({ ok: true, values: [`v=spf1 ip4:10.0.0.${n.length} ~all`] }));
  assert.equal(r2.lookups, 11);
});

const site = (email, host = "www.example.com") => ({ host, org: "example.com", email, home: { final_url: `https://${host}/`, headers: {}, page: null }, pages: [] });

test("multiple SPF records are one finding with a merged suggestion, never 'add another record'", async () => {
  const { dns } = fakeDns({ "example.com TXT": [q("v=spf1 include:_spf.google.com ~all"), q("v=spf1 include:sendgrid.net -all")], "example.com MX": ["10 aspmx.l.google.com."] });
  const checks = runChecks(site(await analyzeEmail("www.example.com", { dns })), "scan");
  const spf = checks.find(c => c.id === "spf");
  assert.equal(spf.status, "fail");
  assert.equal(spf.finding_id, "spf_multiple");
  assert.equal(spf.data.merged, "v=spf1 include:_spf.google.com include:sendgrid.net -all");
  const p = presentFinding({ check_id: "spf_multiple", data: spf.data }, { host: "www.example.com", org: "example.com" });
  assert.match(p.code, /Merged suggestion/);
  assert.ok(!p.steps.join(" ").match(/add (a|another) (second )?spf/i));
});

test("missing SPF: provider-specific advice only when the provider is proven by MX; otherwise no guessing", async () => {
  const google = runChecks(site(await analyzeEmail("www.example.com", { dns: fakeDns({ "example.com MX": ["1 smtp.google.com."] }).dns })), "scan").find(c => c.id === "spf");
  const pg = presentFinding({ check_id: "spf", data: google.data }, { host: "www.example.com", org: "example.com" });
  assert.match(pg.code, /include:_spf\.google\.com/);

  const unknown = runChecks(site(await analyzeEmail("www.example.com", { dns: fakeDns({ "example.com MX": ["10 mail.example-host.net."] }).dns })), "scan").find(c => c.id === "spf");
  const pu = presentFinding({ check_id: "spf", data: unknown.data }, { host: "www.example.com", org: "example.com" });
  assert.match(pu.code, /<provider-include>/);
  assert.ok(!/google|outlook|zoho/i.test(pu.code), "no provider is assumed");

  const noMail = runChecks(site(await analyzeEmail("www.example.com", { dns: fakeDns({}).dns })), "scan").find(c => c.id === "spf");
  assert.match(presentFinding({ check_id: "spf", data: noMail.data }, { host: "x", org: "example.com" }).code, /v=spf1 -all/);
});

test("SPF that omits the mailbox provider: edit the existing record", async () => {
  const { dns } = fakeDns({ "example.com TXT": [q("v=spf1 include:sendgrid.net ~all")], "example.com MX": ["10 example-com.mail.protection.outlook.com."], "sendgrid.net TXT": [q("v=spf1 ip4:1.1.1.1 ~all")] });
  const checks = runChecks(site(await analyzeEmail("www.example.com", { dns })), "scan");
  const miss = checks.find(c => c.id === "spf_provider_missing");
  assert.equal(miss.data.suggested, "v=spf1 include:sendgrid.net include:spf.protection.outlook.com ~all");
  assert.equal(checks.find(c => c.id === "spf").status, "pass", "the record itself is valid");
});

test("permissive and neutral SPF endings", async () => {
  const plus = runChecks(site(await analyzeEmail("example.com", { dns: fakeDns({ "example.com TXT": [q("v=spf1 +all")] }).dns })), "scan").find(c => c.id === "spf");
  assert.equal(plus.severity, "critical");
  const neutral = runChecks(site(await analyzeEmail("example.com", { dns: fakeDns({ "example.com TXT": [q("v=spf1 ip4:1.2.3.4 ?all")] }).dns })), "scan").find(c => c.id === "spf");
  assert.equal(neutral.status, "warn");
});

test("SPF over 10 lookups is a permerror finding", async () => {
  const zone = { "example.com TXT": [q(`v=spf1 ${Array.from({ length: 11 }, (_, i) => `include:s${i}.example.net`).join(" ")} ~all`)] };
  for (let i = 0; i < 11; i++) zone[`s${i}.example.net TXT`] = [q("v=spf1 ip4:10.1.1.1 ~all")];
  const spf = runChecks(site(await analyzeEmail("example.com", { dns: fakeDns(zone).dns })), "scan").find(c => c.id === "spf");
  assert.equal(spf.finding_id, "spf_lookups");
  assert.equal(spf.data.lookups, 11);
});

test("DMARC: parsing, p=none is a warning, and a failed lookup is 'not measured', not 'missing'", async () => {
  assert.equal(parseDmarc("v=DMARC1; p=reject; pct=50").pct, 50);
  assert.ok(parseDmarc("p=reject; v=DMARC1").errors.length, "v must come first");
  assert.ok(parseDmarc("v=DMARC1; p=maybe").errors.length);
  const none = runChecks(site(await analyzeEmail("example.com", { dns: fakeDns({ "_dmarc.example.com TXT": [q("v=DMARC1; p=none")] }).dns })), "scan").find(c => c.id === "dmarc");
  assert.equal(none.status, "warn");
  assert.equal(none.finding_id, "dmarc_policy");
  const broken = async () => ({ ok: false, nxdomain: false, answers: [] });
  const checks = runChecks(site(await analyzeEmail("example.com", { dns: broken })), "scan");
  assert.equal(checks.find(c => c.id === "dmarc").status, "na");
  assert.equal(checks.find(c => c.id === "spf").status, "na");
});

test("DKIM: only reported as unverified, never as missing, and not scored", async () => {
  const e = await analyzeEmail("example.com", { dns: fakeDns({}).dns });
  const dkim = runChecks(site(e), "scan").find(c => c.id === "dkim_unverified");
  assert.equal(dkim.weight, 0);
  assert.equal(dkim.severity, "info");
  const found = await analyzeEmail("example.com", { dns: fakeDns({ "google._domainkey.example.com TXT": [q("v=DKIM1; k=rsa; p=MIIB")] }).dns });
  assert.deepEqual(found.dkim.selectors_found, ["google"]);
});

test("TXT values: split strings are joined", () => {
  assert.equal(txtValue('"v=spf1 include:a.com " "include:b.com ~all"'), "v=spf1 include:a.com include:b.com ~all");
  assert.equal(identifyProvider(["mx.zoho.in"], []).include, "zoho.in");
  assert.equal(identifyProvider([], ["unknown.example"]), null);
});
