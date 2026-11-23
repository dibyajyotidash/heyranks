// Copies the public site files into ./public for Vercel, so source files
// (lib/, schema, README.md, etc.) are never served as static files.
import { mkdirSync, readdirSync, copyFileSync, rmSync, cpSync } from "node:fs";

const PUBLIC_EXT = /\.(html|txt|xml|ico|png|jpg|jpeg|svg|webp|css)$/i;
rmSync("public", { recursive: true, force: true });
mkdirSync("public");
const files = readdirSync(".").filter(f => PUBLIC_EXT.test(f));
for (const f of files) copyFileSync(f, `public/${f}`);
cpSync("assets", "public/assets", { recursive: true }); // shared app CSS/JS for login, dashboard, admin
console.log(`Copied ${files.length} files + assets/ to public/: ${files.join(", ")}`);
