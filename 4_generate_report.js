import { createObjectCsvWriter } from 'csv-writer';
import fs from 'fs';

function pct(n, total) { return total ? `${((n / total) * 100).toFixed(1)}%` : '0%'; }

async function report() {
  const data = JSON.parse(fs.readFileSync('data/classifications.json'));
  fs.mkdirSync('reports', { recursive: true });

  // ── 1. Image-level CSV (one row per image) ─────────────────────────────────
  const imageCsv = createObjectCsvWriter({
    path: 'reports/image_audit.csv',
    header: [
      { id: 'brand',                title: 'Brand' },
      { id: 'family',               title: 'Product Family' },
      { id: 'category',             title: 'Category' },
      { id: 'pdpUrl',               title: 'PDP URL' },
      { id: 'imageUrl',             title: 'Image URL' },
      { id: 'sequencePosition',     title: 'Position in Gallery' },
      { id: 'totalImagesInGallery', title: 'Total Gallery Images' },
      { id: 'shotType',             title: 'Shot Type' },
      { id: 'backgroundStyle',      title: 'Background Style' },
      { id: 'subjectFocus',         title: 'Subject Focus' },
      { id: 'angle',                title: 'Angle' },
      { id: 'sequenceRole',         title: 'Sequence Role' },
      { id: 'confidence',           title: 'Classification Confidence' },
      { id: 'notes',                title: 'Notes' },
      { id: 'error',                title: 'Error' },
    ]
  });
  await imageCsv.writeRecords(data);
  console.log('✅ reports/image_audit.csv written');

  // ── 2. Brand-level pattern summary ─────────────────────────────────────────
  const brandStats = {};
  for (const img of data) {
    if (img.error) continue;
    const k = img.brand;
    if (!brandStats[k]) brandStats[k] = {
      brand: img.brandName, totalImages: 0,
      shotTypes: {}, backgrounds: {}, subjects: {}, angles: {}, roles: {}
    };
    const s = brandStats[k];
    s.totalImages++;
    s.shotTypes[img.shotType]          = (s.shotTypes[img.shotType] || 0) + 1;
    s.backgrounds[img.backgroundStyle] = (s.backgrounds[img.backgroundStyle] || 0) + 1;
    s.subjects[img.subjectFocus]       = (s.subjects[img.subjectFocus] || 0) + 1;
    s.angles[img.angle]                = (s.angles[img.angle] || 0) + 1;
    s.roles[img.sequenceRole]          = (s.roles[img.sequenceRole] || 0) + 1;
  }

  const brandRows = Object.values(brandStats).map(s => ({
    brand:             s.brand,
    totalImages:       s.totalImages,
    topShotType:       Object.entries(s.shotTypes).sort((a, b) => b[1] - a[1])[0]?.[0],
    pctHero:           pct(s.shotTypes.hero || 0, s.totalImages),
    pctLifestyle:      pct(s.shotTypes.lifestyle || 0, s.totalImages),
    pctInUse:          pct(s.shotTypes.in_use || 0, s.totalImages),
    pctDetail:         pct(s.shotTypes.detail_closeup || 0, s.totalImages),
    pctWhiteBg:        pct(s.backgrounds.white || 0, s.totalImages),
    pctLifestyleBg:    pct(s.backgrounds.lifestyle_environment || 0, s.totalImages),
    pctProductOnly:    pct(s.subjects.product_only || 0, s.totalImages),
    pctProductPerson:  pct(s.subjects.product_and_person || 0, s.totalImages),
    pctProductFood:    pct(s.subjects.product_and_food || 0, s.totalImages),
    topAngle:          Object.entries(s.angles).sort((a, b) => b[1] - a[1])[0]?.[0],
  }));

  const brandCsv = createObjectCsvWriter({
    path: 'reports/brand_patterns.csv',
    header: Object.keys(brandRows[0]).map(id => ({ id, title: id }))
  });
  await brandCsv.writeRecords(brandRows);
  console.log('✅ reports/brand_patterns.csv written');

  // ── 3. Console pattern summary ──────────────────────────────────────────────
  console.log('\n📊 Gallery Pattern Summary by Brand:\n');
  console.table(brandRows.map(r => ({
    Brand:            r.brand,
    'Total Imgs':     r.totalImages,
    'Top Shot':       r.topShotType,
    '% White BG':     r.pctWhiteBg,
    '% Lifestyle BG': r.pctLifestyleBg,
    '% Prod Only':    r.pctProductOnly,
    '% w/ Person':    r.pctProductPerson,
    'Top Angle':      r.topAngle,
  })));

  console.log('\n✅ All reports saved to reports/');
  console.log('   image_audit.csv    — one row per image');
  console.log('   brand_patterns.csv — brand-level pattern comparison');
}

report();
