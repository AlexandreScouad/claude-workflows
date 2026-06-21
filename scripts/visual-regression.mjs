// Visual regression runner — exécuté par .github/workflows/visual-regression.yml
// dans AlexandreScouad/claude-workflows. Screenshot chaque route contre le
// preview Vercel, compare aux baselines (Vercel Blob via feedback-app), et
// remonte le verdict à la Quality Gate 5.
//
// Chaîne : config (routes + baselines) → Playwright → pixelmatch → upload
// (baseline/diff/actual) → POST signé /api/webhooks/visual-regression.
//
// Env (injecté par le workflow) : PROJECT_ID, PR_NUMBER, GH_ISSUE_NUMBER,
// PREVIEW_URL, FEEDBACK_APP_URL, VISUAL_REGRESSION_WEBHOOK_SECRET.

import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import pngjs from "pngjs";
import { createHmac } from "node:crypto";

const { PNG } = pngjs;

const {
  PROJECT_ID,
  PR_NUMBER,
  GH_ISSUE_NUMBER,
  PREVIEW_URL,
  FEEDBACK_APP_URL,
  VISUAL_REGRESSION_WEBHOOK_SECRET: SECRET,
} = process.env;

for (const [k, v] of Object.entries({
  PROJECT_ID, PR_NUMBER, GH_ISSUE_NUMBER, PREVIEW_URL, FEEDBACK_APP_URL, SECRET,
})) {
  if (!v) {
    console.error(`Missing env: ${k}`);
    process.exit(1);
  }
}

const BASE = FEEDBACK_APP_URL.replace(/\/$/, "");

// Doit matcher routeToSafeName côté upload route (feedback-app).
const routeSafe = (route) =>
  ((route.startsWith("/") ? route.slice(1) : route)
    .replace(/[/?&=]/g, "__")
    .replace(/[^a-zA-Z0-9_-]/g, "_") || "_root");

async function getConfig() {
  const res = await fetch(`${BASE}/api/projects/${PROJECT_ID}/visual-regression/config`, {
    headers: { authorization: `Bearer ${SECRET}` },
  });
  if (!res.ok) throw new Error(`config ${res.status}: ${await res.text()}`);
  return res.json();
}

async function uploadImage(type, route, buffer) {
  const res = await fetch(`${BASE}/api/projects/${PROJECT_ID}/visual-regression/upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({
      type,
      route,
      prNumber: Number(PR_NUMBER),
      dataBase64: buffer.toString("base64"),
    }),
  });
  if (!res.ok) throw new Error(`upload ${type} ${res.status}: ${await res.text()}`);
  return (await res.json()).url ?? null;
}

// `urlPatterns` côté projet sont des domaines, pas des chemins : on ne garde
// que les entrées ressemblant à un path ("/..."), sinon on retombe sur la home.
function deriveRoutes(config) {
  const paths = (config.routes || []).filter(
    (r) => typeof r === "string" && r.startsWith("/"),
  );
  return paths.length ? paths : ["/"];
}

async function main() {
  const config = await getConfig();
  const vp = config.viewport && typeof config.viewport === "object"
    ? { width: config.viewport.width ?? 1280, height: config.viewport.height ?? 800 }
    : { width: 1280, height: 800 };
  const routes = deriveRoutes(config);
  const baselines = config.baselines || {};
  console.log(`Routes: ${routes.join(", ")} — ${Object.keys(baselines).length} baseline(s)`);

  const browser = await chromium.launch();
  const results = [];
  try {
    const page = await browser.newPage({ viewport: vp });
    for (const route of routes) {
      const url = new URL(route, PREVIEW_URL).toString();
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
      } catch (err) {
        console.warn(`goto ${url} slow/failed: ${err?.message ?? err}`);
      }
      await page.waitForTimeout(500);
      const shot = await page.screenshot({ fullPage: false });
      const safe = routeSafe(route);
      const baselineUrl = baselines[safe];

      if (!baselineUrl) {
        await uploadImage("baseline", route, shot);
        results.push({ route, status: "first-pass" });
        console.log(`  ${route} → first-pass (baseline créée)`);
        continue;
      }

      const baseBuf = Buffer.from(await (await fetch(baselineUrl)).arrayBuffer());
      const baseImg = PNG.sync.read(baseBuf);
      const curImg = PNG.sync.read(shot);

      if (baseImg.width !== curImg.width || baseImg.height !== curImg.height) {
        const screenshotUrl = await uploadImage("actual", route, shot);
        results.push({ route, status: "blocked", diffPx: -1, screenshotUrl });
        console.log(`  ${route} → blocked (dimensions différentes)`);
        continue;
      }

      const diff = new PNG({ width: baseImg.width, height: baseImg.height });
      const diffPx = pixelmatch(
        baseImg.data, curImg.data, diff.data, baseImg.width, baseImg.height,
        { threshold: 0.1 },
      );
      const tolerance = Math.floor(baseImg.width * baseImg.height * 0.001); // 0.1% des pixels
      if (diffPx > tolerance) {
        const diffUrl = await uploadImage("diff", route, PNG.sync.write(diff));
        const screenshotUrl = await uploadImage("actual", route, shot);
        results.push({ route, status: "blocked", diffPx, diffUrl, screenshotUrl });
        console.log(`  ${route} → blocked (${diffPx}px > ${tolerance})`);
      } else {
        results.push({ route, status: "ok", diffPx });
        console.log(`  ${route} → ok (${diffPx}px)`);
      }
    }
  } finally {
    await browser.close();
  }

  const payload = JSON.stringify({
    projectId: PROJECT_ID,
    prNumber: Number(PR_NUMBER),
    ghIssueNumber: Number(GH_ISSUE_NUMBER),
    viewport: `${vp.width}x${vp.height}`,
    results,
  });
  const signature = "sha256=" + createHmac("sha256", SECRET).update(payload).digest("hex");
  const res = await fetch(`${BASE}/api/webhooks/visual-regression`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Scouad-Signature-256": signature },
    body: payload,
  });
  console.log(`Webhook → HTTP ${res.status}: ${await res.text()}`);
  if (!res.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
