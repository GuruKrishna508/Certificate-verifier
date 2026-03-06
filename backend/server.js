/**
 * Certificate Verifier - Backend Server v5
 *
 * KEY FIX: Coursera has TWO types of certificate URLs:
 *   PRIVATE (requires login): coursera.org/account/accomplishments/certificate/CODE
 *   PUBLIC  (shareable):      coursera.org/verify/CODE
 *
 * This server auto-converts private URLs to public verify URLs.
 *
 * Setup: npm install && node server.js
 * Listens on: http://localhost:3001
 */

const express   = require("express");
const cors      = require("cors");
const puppeteer = require("puppeteer");
const multer    = require("multer");
const xlsx      = require("xlsx");
const fs        = require("fs");

const app    = express();
const upload = multer({ dest: "uploads/" });
app.use(cors());
app.use(express.json());

// Words that are NOT a person's name
const BLACKLIST_WORDS = new Set([
  "coursera","udemy","edx","linkedin","nptel","simplilearn","greatlearning",
  "hackerrank","udacity","google","microsoft","amazon","ibm","meta","oracle",
  "certificate","certification","verify","verified","course","learning","online",
  "platform","sign","login","home","menu","search","close","back","share",
  "download","print","view","profile","account","settings","help","privacy",
  "terms","contact","about","blog","news","career","job","accomplishment",
  "specialization","professional","duke","stanford","yale","university","institute",
  "principles","management","introduction","advanced","fundamentals","foundations",
  "programming","development","engineering","science","technology","analysis",
  "design","architecture","security","network","database","machine","artificial",
  "intelligence","deep","neural","cloud","web","mobile","data","business",
  "marketing","finance","economics","statistics","mathematics","physics","biology"
]);

// English "stop words" that appear in course titles but never in person names
const STOP_WORDS = new Set([
  "of","and","the","for","in","to","a","an","with","on","at","by","from",
  "is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","may","might",
  "its","it","this","that","these","those"
]);

function isValidPersonName(text) {
  if (!text || text.length < 4 || text.length > 80) return false;
  const words = text.trim().split(/\s+/);
  if (words.length < 2 || words.length > 6) return false;
  // Person names don't contain stop words like "of", "and", "the", "for"
  if (words.some(w => STOP_WORDS.has(w.toLowerCase()))) return false;
  // All words must be letters only (no numbers, no special chars except . ' -)
  if (!words.every(w => /^[A-Za-z.'\-]+$/.test(w))) return false;
  // Check blacklist
  if (BLACKLIST_WORDS.has(text.toLowerCase().trim())) return false;
  if (words.some(w => BLACKLIST_WORDS.has(w.toLowerCase()))) return false;
  // Must start with uppercase
  if (!words[0][0].match(/[A-Z]/)) return false;
  return true;
}

// Convert private Coursera URL → public verify URL
// coursera.org/account/accomplishments/certificate/CODE → coursera.org/verify/CODE
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("coursera.org")) {
      const m = u.pathname.match(/\/(?:account\/accomplishments\/certificate|accomplishments\/certificate)\/([A-Z0-9]+)/i);
      if (m) {
        const publicUrl = `https://www.coursera.org/verify/${m[1]}`;
        console.log(`[URL] Converted private URL → public: ${publicUrl}`);
        return publicUrl;
      }
    }
  } catch {}
  return url;
}

const PLATFORMS = [
  {
    name: "Coursera",
    domains: ["coursera.org"],
    verifyPathRegex: /\/(verify|certificate|account\/accomplishments)\//i,
    extractName: async (page) => {
      const currentUrl = page.url();
      console.log("[Coursera] Current page URL:", currentUrl);

      // Detect if we got redirected to login page
      if (currentUrl.includes("/login") || currentUrl.includes("/signup")) {
        console.log("[Coursera] ⚠ Redirected to login — URL needs to be public /verify/ link");
        return "__LOGIN_REQUIRED__";
      }

      // Strategy 1: og:description — most reliable
      // Format: "LP GURUKRISHNA SHARMA's Verified Certificate for Python Programming"
      const ogDesc  = await page.$eval('meta[property="og:description"]', el => el.content).catch(() => "");
      const ogTitle = await page.$eval('meta[property="og:title"]', el => el.content).catch(() => "");
      const pageTitle = await page.title().catch(() => "");

      console.log("[Coursera] og:description :", ogDesc);
      console.log("[Coursera] og:title       :", ogTitle);
      console.log("[Coursera] page title      :", pageTitle);

      // "NAME's Verified Certificate for..."
      let m = ogDesc.match(/^([A-Za-z][A-Za-z .'\-]{2,60}?)(?:'s |'s )/);
      if (m && isValidPersonName(m[1])) { console.log("[Coursera] ✓ og:description →", m[1]); return m[1].trim(); }

      // og:title: "CourseName | NAME" or "NAME | CourseName"
      m = ogTitle.match(/\|\s*([A-Za-z][A-Za-z .'\-]{2,60})\s*$/);
      if (m && isValidPersonName(m[1])) { console.log("[Coursera] ✓ og:title (end) →", m[1]); return m[1].trim(); }

      m = ogTitle.match(/^([A-Za-z][A-Za-z .'\-]{2,60})\s*\|/);
      if (m && isValidPersonName(m[1])) { console.log("[Coursera] ✓ og:title (start) →", m[1]); return m[1].trim(); }

      // Strategy 2: Specific CSS selectors
      const specificSelectors = [
        ".cert-name", ".certificate-name",
        "[data-test='certificate-name']", "[data-e2e='cert-name']",
        ".recipient-name",
        "[class*='certName']", "[class*='cert-name']",
        "[class*='recipientName']", "[class*='recipient-name']",
        "[class*='userName']", "[class*='user-name']",
        "[class*='learnerName']", "[class*='learner-name']",
        "[class*='holderName']", "[class*='holder-name']",
        "[class*='accomplishment'] h2",
        "[class*='accomplishment'] h1",
      ];

      for (const sel of specificSelectors) {
        try {
          const els = await page.$$(sel);
          for (const el of els) {
            const text = (await el.evaluate(e => e.innerText.trim())).replace(/\s+/g, " ");
            if (isValidPersonName(text)) {
              console.log(`[Coursera] ✓ CSS "${sel}" → "${text}"`);
              return text;
            }
          }
        } catch {}
      }

      // Strategy 3: Full page text with patterns
      const body = await page.evaluate(() => document.body.innerText);
      console.log("[Coursera] Page text (first 1200 chars):\n" + body.slice(0, 1200) + "\n---");

      const patterns = [
        /(?:certifies?\s+that|awarded\s+to|issued\s+to|presented\s+to|completed\s+by)\s+([A-Z][A-Za-z .'\-]{2,60}?)(?:\n|\r|,|\.|has|in|for|on)/,
        /([A-Z][A-Z .'\-]{4,60})\s+has successfully/,
        /([A-Z][a-z]+(?: [A-Z][a-z]+){1,4})\s+has (?:successfully )?completed/,
        // ALL CAPS full name: "LP GURUKRISHNA SHARMA" (allow 1+ char words)
        /\b([A-Z][A-Z]*(?: [A-Z][A-Z]*){1,4})\b/,
      ];

      for (const p of patterns) {
        const match = body.match(p);
        if (match && match[1] && isValidPersonName(match[1].trim())) {
          console.log(`[Coursera] ✓ pattern → "${match[1].trim()}"`);
          return match[1].trim();
        }
      }

      // Strategy 4: Scan individual leaf text nodes
      const allTexts = await page.evaluate(() => {
        const results = [];
        document.querySelectorAll("p, span, div, h1, h2, h3, h4, td, li, strong, b").forEach(el => {
          if (el.children.length === 0) {
            const t = el.innerText ? el.innerText.trim() : "";
            if (t.length > 3 && t.length < 80) results.push(t);
          }
        });
        return [...new Set(results)];
      });

      console.log("[Coursera] Scanning", allTexts.length, "leaf nodes...");
      for (const t of allTexts) {
        const clean = t.replace(/\s+/g, " ").trim();
        if (isValidPersonName(clean)) {
          console.log(`[Coursera] ✓ leaf node → "${clean}"`);
          return clean;
        }
      }

      return null;
    }
  },
  {
    name: "Udemy",
    domains: ["udemy.com", "ude.my"],
    verifyPathRegex: /\/certificate\//i,
    extractName: async (page) => {
      const ogDesc  = await page.$eval('meta[property="og:description"]', el => el.content).catch(() => "");
      const ogTitle = await page.$eval('meta[property="og:title"]', el => el.content).catch(() => "");
      console.log("[Udemy] og:description:", ogDesc);
      console.log("[Udemy] og:title:", ogTitle);

      let m = ogDesc.match(/^([A-Za-z][A-Za-z .'\-]{2,60}?)(?:'s | has | completed )/i);
      if (m && isValidPersonName(m[1])) return m[1].trim();

      m = ogTitle.match(/^([A-Za-z][A-Za-z .'\-]{2,60})\s*[|–-]/);
      if (m && isValidPersonName(m[1])) return m[1].trim();

      for (const sel of ["[data-purpose='certificate-name']", ".udlite-heading-serif-xl", ".certificate-name"]) {
        try {
          const text = (await page.$eval(sel, el => el.innerText.trim())).replace(/\s+/g, " ");
          if (isValidPersonName(text)) return text;
        } catch {}
      }
      const body = await page.evaluate(() => document.body.innerText);
      console.log("[Udemy] Page text:", body.slice(0, 800));
      const m2 = body.match(/([A-Z][A-Z .'\-]{4,60})\s+has successfully/);
      if (m2 && isValidPersonName(m2[1].trim())) return m2[1].trim();
      return null;
    }
  },
  {
    name: "edX",
    domains: ["edx.org", "courses.edx.org"],
    verifyPathRegex: /\/certificates\//i,
    extractName: async (page) => {
      for (const sel of ["#accomplishment_user_name", ".accomplishment-recipient .name"]) {
        try {
          const text = (await page.$eval(sel, el => el.innerText.trim())).replace(/\s+/g, " ");
          if (isValidPersonName(text)) return text;
        } catch {}
      }
      const body = await page.evaluate(() => document.body.innerText);
      const m = body.match(/([A-Z][a-z]+(?: [A-Z][a-z]+){1,4})\s+(?:has|earned|completed)/i);
      return m && isValidPersonName(m[1]) ? m[1].trim() : null;
    }
  },
  {
    name: "LinkedIn Learning",
    domains: ["linkedin.com", "lnkd.in"],
    verifyPathRegex: /\/(learning|in)\//i,
    extractName: async (page) => {
      for (const sel of [".certificate-viewer__name", ".t-24"]) {
        try {
          const text = (await page.$eval(sel, el => el.innerText.trim())).replace(/\s+/g, " ");
          if (isValidPersonName(text)) return text;
        } catch {}
      }
      return null;
    }
  },
  {
    name: "NPTEL",
    domains: ["nptel.ac.in", "archive.nptel.ac.in", "nptel.gov.in"],
    verifyPathRegex: /.*/,
    extractName: async (page) => {
      for (const sel of [".student-name", "#studentName", "td.name"]) {
        try {
          const text = (await page.$eval(sel, el => el.innerText.trim())).replace(/\s+/g, " ");
          if (isValidPersonName(text)) return text;
        } catch {}
      }
      const body = await page.evaluate(() => document.body.innerText);
      const m = body.match(/(?:certifies? that|awarded to)\s+([A-Z][a-zA-Z .'\-]{2,60})/i);
      return m && isValidPersonName(m[1]) ? m[1].trim() : null;
    }
  },
  {
    name: "Simplilearn",
    domains: ["simplilearn.com"],
    verifyPathRegex: /\/certificate/i,
    extractName: async (page) => {
      for (const sel of [".certificate-name", ".cert-holder-name", ".user-name"]) {
        try {
          const text = (await page.$eval(sel, el => el.innerText.trim())).replace(/\s+/g, " ");
          if (isValidPersonName(text)) return text;
        } catch {}
      }
      return null;
    }
  },
  {
    name: "Great Learning",
    domains: ["greatlearning.in", "greatlearning.com", "mygreatlearning.com"],
    verifyPathRegex: /.*/,
    extractName: async (page) => {
      for (const sel of [".certificate-name", ".student-name", ".recipient"]) {
        try {
          const text = (await page.$eval(sel, el => el.innerText.trim())).replace(/\s+/g, " ");
          if (isValidPersonName(text)) return text;
        } catch {}
      }
      return null;
    }
  },
  {
    name: "HackerRank",
    domains: ["hackerrank.com"],
    verifyPathRegex: /\/certificates\//i,
    extractName: async (page) => {
      const ogTitle = await page.$eval('meta[property="og:title"]', el => el.content).catch(() => "");
      const m = ogTitle.match(/^([A-Za-z][A-Za-z .'\-]{2,60}?)\s*[|–-]/);
      if (m && isValidPersonName(m[1])) return m[1].trim();
      for (const sel of [".certificate-name", ".hacker-name"]) {
        try {
          const text = (await page.$eval(sel, el => el.innerText.trim())).replace(/\s+/g, " ");
          if (isValidPersonName(text)) return text;
        } catch {}
      }
      return null;
    }
  }
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function detectPlatform(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return PLATFORMS.find(p => p.domains.some(d => hostname === d || hostname.endsWith("." + d))) || null;
  } catch { return null; }
}

function normalizeName(n) {
  return n.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
}

function nameSimilarity(a, b) {
  a = normalizeName(a); b = normalizeName(b);
  if (a === b) return 1.0;
  // If one name is fully contained in the other (e.g. extracted="gurukrishna sharma"
  // vs expected="lp gurukrishna sharma"), treat as strong match
  if (a.includes(b) || b.includes(a)) return 0.9;
  const wa = a.split(" "), wb = b.split(" ");
  const common = wa.filter(w => wb.includes(w));
  const jaccard = common.length / new Set([...wa, ...wb]).size;
  const dice    = (2 * common.length) / (wa.length + wb.length);
  return Math.max(jaccard, dice);
}

// ─── Puppeteer ────────────────────────────────────────────────────────────────
async function extractNameFromCertPage(url, platform) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox",
             "--disable-blink-features=AutomationControlled",
             "--disable-dev-shm-usage", "--window-size=1280,900"]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins",   { get: () => [1, 2, 3] });
      window.chrome = { runtime: {} };
    });

    console.log(`\n[Browser] Loading: ${url}`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 40000 });
    await new Promise(r => setTimeout(r, 4000));

    const name = await platform.extractName(page);
    await browser.close();
    return name;
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    throw err;
  }
}

// ─── Core verify ──────────────────────────────────────────────────────────────
async function verifyCertificate(rawUrl, expectedName) {
  const url = normalizeUrl(rawUrl);  // auto-convert private → public URL
  const result = { url, originalUrl: rawUrl !== url ? rawUrl : undefined, expectedName, checks: [] };

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    result.checks.push({ name: "URL Format", status: "pass", detail: "Valid URL format" });
  } catch {
    result.checks.push({ name: "URL Format", status: "fail", detail: "Not a valid URL" });
    return { ...result, verdict: "fail" };
  }

  // Warn if URL was a private account URL (auto-converted)
  if (rawUrl !== url) {
    result.checks.push({
      name: "URL Type",
      status: "warn",
      detail: `Private account URL detected — auto-converted to public verify URL: ${url}`
    });
  }

  result.checks.push({
    name: "Secure (HTTPS)", status: url.startsWith("https://") ? "pass" : "warn",
    detail: url.startsWith("https://") ? "URL uses HTTPS" : "URL does not use HTTPS"
  });

  const platform = detectPlatform(url);
  if (!platform) {
    result.checks.push({ name: "Platform Recognition", status: "fail", detail: "Not from a recognized platform (Coursera, Udemy, edX, etc.)" });
    return { ...result, verdict: "fail" };
  }
  result.platform = platform.name;
  result.checks.push({ name: "Platform Recognition", status: "pass", detail: `Recognized as ${platform.name}` });

  const pathOk = platform.verifyPathRegex.test(parsedUrl.pathname);
  result.checks.push({
    name: "Certificate URL Path", status: pathOk ? "pass" : "warn",
    detail: pathOk ? `URL matches ${platform.name}'s certificate format` : `URL path may not be a certificate link`
  });

  let extractedName = null;
  try {
    extractedName = await extractNameFromCertPage(url, platform);
  } catch (err) {
    result.checks.push({ name: "Page Load", status: "fail", detail: `Failed: ${err.message}` });
    return { ...result, verdict: "fail" };
  }

  // Special case: login required
  if (extractedName === "__LOGIN_REQUIRED__") {
    result.checks.push({
      name: "Name Extraction", status: "fail",
      detail: `Certificate page requires login. Please use the public shareable URL: coursera.org/verify/CODE (not the account URL)`
    });
    return { ...result, verdict: "fail" };
  }

  if (!extractedName) {
    result.checks.push({ name: "Name Extraction", status: "warn", detail: "Page loaded but name not found. Check terminal logs for debug info." });
    return { ...result, verdict: "warn" };
  }

  result.extractedName = extractedName;
  result.checks.push({ name: "Name Extraction", status: "pass", detail: `Found on certificate: "${extractedName}"` });

  const sim = nameSimilarity(extractedName, expectedName);
  result.similarity = Math.round(sim * 100);

  if (sim >= 0.75) {
    result.checks.push({ name: "Name Match", status: "pass", detail: `Names match ✓  Certificate: "${extractedName}" — Expected: "${expectedName}" (${result.similarity}%)` });
    result.verdict = "pass";
  } else if (sim >= 0.4) {
    result.checks.push({ name: "Name Match", status: "warn", detail: `Partial match (${result.similarity}%): certificate says "${extractedName}", expected "${expectedName}" — verify manually` });
    result.verdict = "warn";
  } else {
    result.checks.push({ name: "Name Match", status: "fail", detail: `Mismatch: certificate has "${extractedName}", expected "${expectedName}"` });
    result.verdict = "fail";
  }
  return result;
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.post("/api/verify", async (req, res) => {
  const { url, expectedName } = req.body;
  if (!url || !expectedName) return res.status(400).json({ error: "url and expectedName are required" });
  try { res.json(await verifyCertificate(url, expectedName)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/verify-bulk", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  try {
    const wb   = xlsx.readFile(req.file.path);
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    if (!rows.length) return res.status(400).json({ error: "File is empty" });
    const results = [];
    for (const row of rows) {
      const url          = row.url || row.certificate_url || row.URL || row["Certificate URL"] || "";
      const expectedName = row.name || row.expected_name || row.Name || row["Expected Name"] || row["Student Name"] || "";
      if (!url || !expectedName) { results.push({ url, expectedName, verdict: "skip" }); continue; }
      results.push(await verifyCertificate(url, expectedName));
    }
    fs.unlinkSync(req.file.path);
    res.json({
      summary: { total: results.length, pass: results.filter(r=>r.verdict==="pass").length, warn: results.filter(r=>r.verdict==="warn").length, fail: results.filter(r=>r.verdict==="fail").length, skip: results.filter(r=>r.verdict==="skip").length },
      results
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// Debug: dumps raw page data so you can inspect what Puppeteer actually sees
app.post("/api/debug", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-blink-features=AutomationControlled","--disable-dev-shm-usage"]
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      window.chrome = { runtime: {} };
    });
    const normalized = normalizeUrl(url);
    await page.goto(normalized, { waitUntil: "networkidle2", timeout: 40000 });
    await new Promise(r => setTimeout(r, 4000));

    const ogDesc    = await page.$eval('meta[property="og:description"]', el => el.content).catch(() => "");
    const ogTitle   = await page.$eval('meta[property="og:title"]',       el => el.content).catch(() => "");
    const pageTitle = await page.title().catch(() => "");
    const bodyText  = await page.evaluate(() => document.body.innerText);
    const finalUrl  = page.url();

    // Collect all leaf text nodes
    const leafTexts = await page.evaluate(() => {
      const r = [];
      document.querySelectorAll("p,span,div,h1,h2,h3,h4,td,li,strong,b").forEach(el => {
        if (el.children.length === 0) {
          const t = (el.innerText || "").trim();
          if (t.length > 2 && t.length < 100) r.push(t);
        }
      });
      return [...new Set(r)].slice(0, 80);
    });

    await browser.close();
    res.json({ normalizedUrl: normalized, finalUrl, ogTitle, ogDesc, pageTitle, bodyText: bodyText.slice(0, 2000), leafTexts });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`\n✅ Certificate Verifier v6 — http://localhost:${PORT}`);
  console.log(`   Fixed: course title words (of/and/the/for) rejected as names`);
  console.log(`   POST /api/verify      → single verify`);
  console.log(`   POST /api/verify-bulk → bulk Excel/CSV`);
  console.log(`   POST /api/debug       → dump raw page data for debugging\n`);
});