// Crawler primitives: robots.txt, sitemaps, URL handling and HTML extraction. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRobots, robotsAllows, robotsCrawlDelay, parseSitemap, normalizeUrl, sameSite, isCrawlable, extractPage, similarity } from "../lib/crawler.js";

test("robots.txt: longest match wins, allow wins ties, wildcards and $ anchors", () => {
  const r = parseRobots(`
User-agent: *
Disallow: /private/
Allow: /private/press/
Disallow: /*.pdf$
Disallow: /search?

User-agent: GPTBot
User-agent: ClaudeBot
Disallow: /

User-agent: Googlebot
Disallow:
Crawl-delay: 2
Sitemap: https://example.com/sitemap.xml`);
  assert.equal(robotsAllows(r, "heyranksbot", "/"), true);
  assert.equal(robotsAllows(r, "heyranksbot", "/private/x"), false);
  assert.equal(robotsAllows(r, "heyranksbot", "/private/press/2026"), true, "longer allow wins");
  assert.equal(robotsAllows(r, "heyranksbot", "/files/a.pdf"), false);
  assert.equal(robotsAllows(r, "heyranksbot", "/files/a.pdf?x=1"), true, "$ anchors the end");
  assert.equal(robotsAllows(r, "heyranksbot", "/search?q=x"), false);
  assert.equal(robotsAllows(r, "GPTBot", "/"), false, "grouped user-agents share rules");
  assert.equal(robotsAllows(r, "ClaudeBot", "/anything"), false);
  assert.equal(robotsAllows(r, "Googlebot", "/private/x"), true, "a named group replaces the * group");
  assert.equal(robotsCrawlDelay(r, "Googlebot"), 2);
  assert.deepEqual(r.sitemaps, ["https://example.com/sitemap.xml"]);
  assert.equal(robotsAllows(parseRobots("User-agent: *\nDisallow: /\nAllow: /$"), "x", "/"), true, "equal-length allow wins");
  assert.equal(robotsAllows(null, "x", "/anything"), true, "no robots.txt means allowed");
});

test("sitemaps: urlset, index, CDATA and entities", () => {
  const set = parseSitemap(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>https://example.com/a?x=1&amp;y=2</loc><lastmod>2026-01-01</lastmod></url>
    <url><loc><![CDATA[https://example.com/b]]></loc></url></urlset>`);
  assert.equal(set.type, "urlset");
  assert.deepEqual(set.urls.map(u => u.loc), ["https://example.com/a?x=1&y=2", "https://example.com/b"]);
  const idx = parseSitemap(`<sitemapindex><sitemap><loc>https://example.com/s1.xml</loc></sitemap></sitemapindex>`);
  assert.equal(idx.type, "index");
  assert.deepEqual(idx.sitemaps, ["https://example.com/s1.xml"]);
  assert.equal(parseSitemap("<html>not a sitemap</html>").type, null);
});

test("URLs: normalisation, same site (www twin) and skipped file types", () => {
  assert.equal(normalizeUrl("/about#team", "https://Example.com/x"), "https://example.com/about");
  assert.equal(normalizeUrl("https://example.com:443/a"), "https://example.com/a");
  assert.equal(normalizeUrl("mailto:a@b.com", "https://example.com/"), null);
  assert.equal(normalizeUrl("javascript:void(0)", "https://example.com/"), null);
  assert.ok(sameSite("https://www.example.com/x", "example.com"));
  assert.ok(!sameSite("https://evil-example.com/", "example.com"));
  assert.ok(!sameSite("https://shop.example.com/", "example.com"), "other subdomains are other sites");
  assert.equal(isCrawlable("https://example.com/brochure.PDF"), false);
  assert.equal(isCrawlable("https://example.com/services/"), true);
});

const HTML = `<!doctype html><html lang="en"><head>
<title>Sunrise Dental &amp; Implants | Bhubaneswar</title>
<meta name="description" content="Family dentist in Bhubaneswar.">
<meta name=robots content="noindex, follow">
<link rel="canonical" href="/home">
<meta property="og:title" content="Sunrise Dental"><meta property="og:image" content="https://cdn.example/og.jpg">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Dentist","name":"Sunrise","dateModified":"2020-01-01"},{"@type":"WebSite"}]}</script>
<script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>
<script src="http://insecure.example/lib.js"></script>
</head><body>
<h1>Dentist in Bhubaneswar</h1><h3>Skipped a level</h3>
<p>We look after families. Read our testimonials from happy patients.</p>
<a href="/contact">Contact us</a> <a href="tel:+911234">Call</a> <a href="https://other.example/page" rel="nofollow">Partner</a>
<a href="/privacy-policy">Privacy</a>
<img src="a.jpg" alt="Reception"><img src="b.jpg"><img src="http://insecure.example/c.jpg" alt="">
<form><label for="e">Email</label><input id="e" name="email"><input name="phone"><input type="hidden" name="t"><button>Book a visit</button></form>
<script>document.write("ignore me")</script>
</body></html>`;

test("extractPage reads everything the checks need", () => {
  const p = extractPage(HTML, "https://example.com/");
  assert.equal(p.title, "Sunrise Dental & Implants | Bhubaneswar");
  assert.equal(p.noindex, true);
  assert.equal(p.canonical, "https://example.com/home");
  assert.equal(p.lang, "en");
  assert.deepEqual(p.h1, ["Dentist in Bhubaneswar"]);
  assert.deepEqual(p.headings.map(h => h.level), [1, 3]);
  assert.deepEqual(p.jsonld.types, ["Dentist", "WebSite"]);
  assert.deepEqual(p.dates, ["2020-01-01"]);
  assert.equal(p.links.internal.length, 2);
  assert.equal(p.links.external[0].nofollow, true);
  assert.equal(p.images.total, 3);
  assert.equal(p.images.missing_alt_count, 1, "alt=\"\" counts as present (decorative)");
  assert.deepEqual(p.mixed.active, ["http://insecure.example/lib.js"]);
  assert.deepEqual(p.mixed.passive, ["http://insecure.example/c.jpg"]);
  assert.deepEqual(p.analytics, ["Google Analytics / Tag Manager"]);
  assert.equal(p.forms.fields, 2);
  assert.equal(p.forms.unlabelled, 1);
  const wrapped = extractPage(`<html><body><label class="q"><input type="checkbox"> My site loads fast</label><input aria-label="Search"></body></html>`, "https://example.com/");
  assert.equal(wrapped.forms.unlabelled, 0, "an input inside its <label> is labelled");
  assert.ok(p.conversion.cta.includes("Book a visit"));
  assert.equal(p.conversion.phones, 1);
  assert.equal(p.conversion.trust, true);
  assert.equal(p.conversion.privacy_link, true);
  assert.ok(!p.text_excerpt.includes("ignore me"), "script contents aren't page text");
  const js = extractPage('<html><body><a href="/real">Real</a><script>out.innerHTML=`<a href="/signup?website=${x}">x</a><img src="a.png">`</script><template><a href="/tpl">t</a></template></body></html>', "https://example.com/");
  assert.deepEqual(js.links.internal.map(l => l.url), ["https://example.com/real"], "links inside scripts and templates aren't crawled");
  assert.equal(js.images.total, 0);
});

test("near-duplicate detection via MinHash", () => {
  const base = Array.from({ length: 300 }, (_, i) => `word${i % 120}`).join(" ");
  const a = extractPage(`<html><body><p>${base}</p></body></html>`, "https://example.com/a");
  const b = extractPage(`<html><body><p>${base} extra words here</p></body></html>`, "https://example.com/b");
  const c = extractPage(`<html><body><p>${Array.from({ length: 300 }, (_, i) => `other${i}`).join(" ")}</p></body></html>`, "https://example.com/c");
  assert.ok(similarity(a.minhash, b.minhash) >= 0.9);
  assert.ok(similarity(a.minhash, c.minhash) < 0.2);
});
