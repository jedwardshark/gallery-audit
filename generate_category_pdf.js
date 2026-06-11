// One-off: render a multi-page PDF where each page is one product-category, with all
// of that category's images tiled at 20% opacity as a ghosted texture, and the category
// name overlaid on top.
//
// Input:  data/gallery_raw.json
// Output: data/category_overview.pdf
//
// Categorization: Dreame's productType is used directly when present (clean Shopify
// signal). All other brands fall through to keyword pattern matching on URL + family +
// SKU + category fields. Unmatched PDPs land in "Other".
//
// Cap: 120 images per page, evenly sampled if a category has more. Keeps the PDF size
// in the 30-80MB range rather than 500MB+ for the full ~21K image set.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PDF = path.join(__dirname, 'data/category_overview.pdf');
const TEMP_HTML  = path.join(__dirname, 'data/_category_overview.html');
const MAX_IMAGES_PER_PAGE = 120;

// ── Category derivation ─────────────────────────────────────────────────────
// Order matters: first match wins. Most-specific patterns first.
const CATEGORY_PATTERNS = [
  ['Robot Vacuums',             /\brobot[- ]?vac|dreamebot|\b(l10s|l20|l40|l50|l60|x30|x40|x60|matrix10|d10|d20|aqua10)[ -]/i],
  ['Cordless Stick Vacuums',    /cordless[- ]?stick|stick[- ]?vacuum|cordless[- ]?vacuum|\b(r10|r20|z10|z20|z30)[- ]/i],
  ['Wet/Dry Vacuums',           /wet[- ]?and[- ]?dry|wet[- ]?dry|h12|h14|h15|aero[- ]?pro/i],
  ['Upright Vacuums',           /upright|stratos|navigator|rotator|\baz\d/i],
  ['Air Fryers',                /air[- ]?fryer|air[- ]?fry|\baf\d|\bfoodi/i],
  ['Air Purifiers',             /air[- ]?purifier|purifier|\bhc\d/i],
  ['Espresso Machines',         /espresso|barista|cafe-?premier|\bcfn\d|\bae1\d|\bbes\d/i],
  ['Coffee Makers',             /coffee[- ]?maker|drip[- ]?coffee|\bcm\d|specialty[- ]?coffee/i],
  ['Blenders',                  /blender|nutri[- ]?ninja|\b5200|\b5300|\b7500|ascent|aer[- ]?disc/i],
  ['Hair Dryers',               /hair[- ]?dryer|gleam|pocket.{0,15}dryer/i],
  ['Hair Stylers',              /hair[- ]?styler|airstyle|airwrap/i],
  ['Floor Cleaners',            /floor[- ]?washer|floor[- ]?cleaner|aqua10|aero[- ]?floor/i],
  ['Cookers & Multicookers',    /possible[- ]?cooker|pressure[- ]?cooker|slow[- ]?cooker|rice[- ]?cooker|multi[- ]?cooker|instant[- ]?cooker|foodi-pos/i],
  ['Ice Cream Makers',          /creami|ice[- ]?cream/i],
  ['Steam Cleaners',            /steam[- ]?cleaner|sh10|\bn20\b/i],
  ['Pool Cleaners',             /pool[- ]?cleaner|\bz1[- ]pool/i],
  ['Toaster Ovens',             /toaster[- ]?oven|french[- ]?door|\bfo\d/i],
  ['Knives & Cutlery',          /\bknife|knives|cleaver|sharpener|santoku|chef[- ]?knife/i],
  ['Cookware',                  /skillet|dutch[- ]?oven|saucepan|saut[ée][- ]?pan|braiser|stockpot|griddle|cast[- ]?iron|tagine|roasting|wok|fry[- ]?pan|\bpan\b|\bpot\b/i],
  ['Bakeware',                  /bundt|cake[- ]?pan|muffin|loaf[- ]?pan|sheet[- ]?pan|cookie[- ]?sheet|tart[- ]?pan|pie[- ]?dish|springform|baking[- ]?dish/i],
  ['Mixers',                    /stand[- ]?mixer|hand[- ]?mixer/i],
  ['Kettles',                   /kettle/i],
  ['Juicers',                   /juicer/i],
  ['Toasters',                  /\btoaster\b/i],
  ['Beverage / Drinks',         /thirsti|drink[- ]?maker|slushi|frozen[- ]?drink|co2[- ]?canister/i],
  ['Fans & Heaters',            /flexbreeze|pedestal[- ]?fan|fan[- ]?with[- ]?cover|portable[- ]?fan/i],
  ['Grills',                    /woodfire|grill|smoker/i],
  ['Cooking Utensils',          /spatula|spoon|whisk|tongs|ladle|turner/i],
];

function deriveCategory(pdp) {
  // Dreame: trust Shopify product_type directly
  if (pdp.brand === 'dreame' && pdp.productType) return pdp.productType;

  // Keyword match against pooled text
  const haystack = [pdp.url, pdp.family, pdp.sku, pdp.category, pdp.productTitle]
    .filter(Boolean).join(' ').toLowerCase();
  for (const [name, re] of CATEGORY_PATTERNS) {
    if (re.test(haystack)) return name;
  }
  return 'Other';
}

// ── Sampling ────────────────────────────────────────────────────────────────
function sampleEvenly(arr, max) {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  return Array.from({ length: max }, (_, i) => arr[Math.floor(i * step)]);
}

// ── Thumbnail URL transform — shrink large source URLs where possible to keep
//    the PDF size in check. Shopify and Cloudinary support inline transforms.
function thumbify(src) {
  if (!src) return src;
  // Shopify CDN: append width param
  if (src.includes('cdn.shopify.com') || src.includes('cdn.shopifycdn.net')) {
    const sep = src.includes('?') ? '&' : '?';
    return src + sep + 'width=240';
  }
  // Cloudinary-style URLs (sharkninja-sfcc-prod-res.cloudinary.com, assets.sharkninja.com)
  // Find the /upload/ segment and inject a w_240 transform.
  const m = src.match(/\/image\/upload\/([^/]+)\//);
  if (m) {
    const existing = m[1];
    // If existing transforms already include w_NNN, replace it; otherwise prepend w_240
    const newT = /w_\d+/.test(existing) ? existing.replace(/w_\d+/, 'w_240') : `w_240,${existing}`;
    return src.replace(`/image/upload/${existing}/`, `/image/upload/${newT}/`);
  }
  return src; // unknown CDN — pass through
}

// ── HTML page builder ──────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderPage(category, pdps, total, sampled) {
  const tiles = sampled.map(src =>
    `<img src="${escapeHtml(src)}" loading="eager" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`
  ).join('');
  const subtitle = (sampled.length < total)
    ? `${pdps.length} PDPs · ${total} images total · ${sampled.length} shown (evenly sampled)`
    : `${pdps.length} PDPs · ${total} images`;
  return `
    <section class="category-page">
      <div class="bg-grid">${tiles}</div>
      <div class="title-overlay">
        <h1>${escapeHtml(category)}</h1>
        <p>${escapeHtml(subtitle)}</p>
      </div>
    </section>`;
}

function buildHtml(orderedCategories) {
  const pages = orderedCategories.map(({ name, pdps, allImages, sampledImages }) =>
    renderPage(name, pdps, allImages.length, sampledImages)
  ).join('\n');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Category Overview</title>
<style>
  @page { size: Letter; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #111; background: #fff; }
  .category-page { position: relative; width: 8.5in; height: 11in; page-break-after: always; overflow: hidden; background: #fff; }
  .category-page:last-child { page-break-after: auto; }
  .bg-grid { display: grid; grid-template-columns: repeat(10, 1fr); gap: 0; width: 100%; height: 100%; }
  .bg-grid img { width: 100%; aspect-ratio: 1; object-fit: cover; opacity: 0.20; display: block; }
  .title-overlay { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); text-align: center; padding: 0.6in 0.8in; background: rgba(255,255,255,0.92); border-radius: 12px; box-shadow: 0 8px 40px rgba(0,0,0,0.08); max-width: 7in; }
  .title-overlay h1 { font-size: 44pt; font-weight: 800; margin: 0 0 0.15in 0; letter-spacing: -0.02em; }
  .title-overlay p { font-size: 12pt; color: #666; margin: 0; font-weight: 500; }
</style></head>
<body>${pages}</body></html>`;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/gallery_raw.json'), 'utf8'));
  const usable = data.filter(p => Array.isArray(p.images) && p.images.length > 0 && !p.skipped && !p.error);
  console.log(`[PDF] Loaded ${data.length} entries, ${usable.length} usable (have images + not skipped/errored)`);

  // Group by derived category
  const grouped = {};
  for (const pdp of usable) {
    const cat = deriveCategory(pdp);
    (grouped[cat] = grouped[cat] || []).push(pdp);
  }

  // For each category, collect all image sources (deduped) and sample down to MAX_IMAGES_PER_PAGE
  const orderedCategories = Object.entries(grouped)
    .map(([name, pdps]) => {
      const allSeen = new Set();
      const allImages = [];
      for (const p of pdps) {
        for (const img of p.images) {
          if (allSeen.has(img.src)) continue;
          allSeen.add(img.src);
          allImages.push(thumbify(img.src));
        }
      }
      const sampledImages = sampleEvenly(allImages, MAX_IMAGES_PER_PAGE);
      return { name, pdps, allImages, sampledImages };
    })
    // Sort by image count desc, but force "Other" to the end
    .sort((a, b) => {
      if (a.name === 'Other') return 1;
      if (b.name === 'Other') return -1;
      return b.allImages.length - a.allImages.length;
    });

  console.log('[PDF] Category breakdown:');
  orderedCategories.forEach(c => {
    console.log(`  ${c.name.padEnd(30)} ${String(c.pdps.length).padStart(4)} PDPs  ${String(c.allImages.length).padStart(5)} images  → ${c.sampledImages.length} on page`);
  });

  // Build HTML
  const html = buildHtml(orderedCategories);
  fs.writeFileSync(TEMP_HTML, html);
  console.log(`[PDF] Wrote ${(html.length / 1024).toFixed(1)} KB of HTML to ${TEMP_HTML}`);

  // Render to PDF via headless Chromium
  console.log('[PDF] Launching browser…');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 816, height: 1056 } }); // 8.5" × 11" at 96dpi

  console.log('[PDF] Loading HTML (fetching all images — this is the slow part)…');
  await page.goto('file://' + TEMP_HTML, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for images to settle. networkidle would block forever on many CDNs; manually
  // poll for image completion with a generous timeout instead.
  const t0 = Date.now();
  while (Date.now() - t0 < 300000) { // 5 min cap
    const status = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img')];
      const total = imgs.length;
      const settled = imgs.filter(i => i.complete).length;
      return { total, settled };
    });
    process.stdout.write(`  images loaded: ${status.settled}/${status.total}\r`);
    if (status.settled >= status.total) break;
    await page.waitForTimeout(2000);
  }
  console.log('');

  console.log('[PDF] Generating PDF…');
  await page.pdf({
    path: OUTPUT_PDF,
    format: 'Letter',
    printBackground: true,
    preferCSSPageSize: true,
  });
  await browser.close();

  // Clean up temp HTML
  fs.unlinkSync(TEMP_HTML);

  const stat = fs.statSync(OUTPUT_PDF);
  console.log(`[PDF] Written: ${OUTPUT_PDF}  (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch(e => {
  console.error('[PDF] FATAL:', e);
  process.exit(1);
});
