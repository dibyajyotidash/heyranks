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
