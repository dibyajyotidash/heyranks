// Scanner parsing and SSRF guards. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { metaTags, normalize, isPrivateAddress } from "../lib/core.js";

const has = (html, attr, value) => metaTags(html).some(m => (m[attr] || "").toLowerCase() === value);

test("finds viewport/description/og meta in quoted, single-quoted and unquoted forms", () => {
  // example.com's real markup: unquoted name=viewport (this was reported as missing before)
  assert.ok(has(`<meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">`, "name", "viewport"));
  assert.ok(has(`<meta name="viewport" content="width=device-width">`, "name", "viewport"));
  assert.ok(has(`<meta content='width=device-width' name='Viewport'>`, "name", "viewport"));
  assert.ok(has(`<META PROPERTY=og:title CONTENT="Hi">`, "property", "og:title"));
  assert.ok(!has(`<meta name="viewport-ish" content="x">`, "name", "viewport"));
  assert.ok(!has(`<p>name="viewport"</p>`, "name", "viewport"));
  const d = metaTags(`<meta content="A long description here" name=description>`).find(m => m.name === "description");
  assert.equal(d.content, "A long description here");
});

test("normalize strips protocol case-insensitively and keeps the hostname", () => {
  assert.equal(normalize("HTTPS://Example.com/some/page").hostname, "example.com");
  assert.equal(normalize("  example.com ").hostname, "example.com");
});

test("normalize rejects empty, dotless and private hosts", () => {
  assert.throws(() => normalize(""), /enter a website/);
  assert.throws(() => normalize("localhost"), /look like a website/);
  for (const h of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.169.254",
                   "100.64.0.1", "0.0.0.0", "[::1]", "printer.local", "api.internal", "foo.localhost"]) {
    assert.throws(() => normalize(h), /Invalid host|look like/, h);
  }
});

test("public addresses are allowed", () => {
  for (const h of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700::1111", "example.com"]) assert.equal(isPrivateAddress(h), false, h);
  for (const h of ["::ffff:127.0.0.1", "fd00::1", "fe80::1"]) assert.equal(isPrivateAddress(h), true, h);
});

test("IPv6 forms that wrap a private IPv4 are caught after URL parsing rewrites them", () => {
  // new URL() turns [::ffff:127.0.0.1] into [::ffff:7f00:1]; both spellings must be rejected.
  for (const h of ["[::ffff:127.0.0.1]", "[::ffff:169.254.169.254]", "[64:ff9b::127.0.0.1]", "[::127.0.0.1]"]) {
    assert.throws(() => normalize(h), /Invalid host/, h);
  }
  for (const h of ["::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::a00:1", "::ffff:c0a8:101"]) assert.equal(isPrivateAddress(h), true, h);
  assert.equal(isPrivateAddress("::ffff:808:808"), false, "8.8.8.8 wrapped in IPv6 is public");
});

// fetchPublic follows redirects itself. A fake fetch stands in for the network; the start host is a public
// IP literal, so the DNS check answers locally without a lookup.
const { fetchPublic } = await import("../lib/core.js");
async function withFakeFetch(handler, fn) {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => { calls.push(String(url)); assert.equal(init.redirect, "manual"); return handler(String(url)); };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}
const redirect = location => new Response(null, { status: 302, headers: { location } });

test("redirects to private or non-web addresses are never fetched", async () => {
  for (const target of ["http://127.0.0.1:9001/2018-06-01/runtime/invocation/next", "http://169.254.169.254/latest/meta-data/",
                        "http://[::ffff:a9fe:a9fe]/", "http://printer.local/", "file:///etc/passwd"]) {
    await withFakeFetch(url => (url.startsWith("https://93.184.216.34/") ? redirect(target) : new Response("secret")), async calls => {
      const r = await fetchPublic("https://93.184.216.34/");
      assert.equal(r.ok, false, target);
      assert.deepEqual(calls, ["https://93.184.216.34/"], `${target} must not be requested`);
    });
  }
});

test("public redirects are followed, relative ones included, up to 5 hops", async () => {
  await withFakeFetch(url => (url.endsWith("/final") ? new Response("hello") : redirect("/final")), async calls => {
    const r = await fetchPublic("https://93.184.216.34/start");
    assert.equal(r.ok, true);
    assert.equal(r.text, "hello");
    assert.equal(r.finalUrl, "https://93.184.216.34/final");
    assert.equal(calls.length, 2);
  });
  await withFakeFetch(() => redirect("/again"), async calls => {
    assert.equal((await fetchPublic("https://93.184.216.34/")).ok, false, "a redirect loop gives up");
    assert.equal(calls.length, 6);
  });
});
