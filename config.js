export const BRANDS = {
  dreame: {
    name: 'Dreame',
    // US storefront — Shopify-backed.
    sitemaps: ['https://www.dreametech.com/sitemap.xml'],
    pdpPattern: /\/products\/[a-z0-9-]+$/i,
    // pdpExcludeKeywords is an EXCLUSION filter (vs. WS's pdpKeywords which is
    // inclusion). The extractor checks the URL handle against this pattern and, if it
    // matches, returns a skip record (skipped: true, skipReason: 'accessory') rather
    // than calling the JSON API. Accessories remain visible in gallery_raw.json so any
    // mis-classified real product can be spotted in the viewer.
    pdpExcludeKeywords: /(brush|mop|filter|cleaning-solution|detergent|water-tank|dust-bag|spare-parts|cover-replacement|\d+pc)/i,
    familySegment: 1,
    categorySegment: 1,
    // No gallerySelectors — Dreame uses the Shopify product JSON API path, not the
    // DOM scrape, so brand-specific selectors don't apply.
  },
  sharkninja: {
    name: 'SharkNinja',
    sitemaps: [
      'https://www.sharkninja.com/sitemap_index.xml',
      'https://www.sharkninja.com/sitemaps/sitemap.xml',
    ],
    // PDP URL shape on sharkninja.com is /{shark|ninja-slug}/{SKU}.html — match the
    // slug-then-SKU.html structure, not the older "SKU embedded in slug" pattern
    // that this regex previously required. Old pattern accidentally only matched
    // ~26 PDPs whose SKU happened to also appear inside the slug.
    pdpPattern: /\/(shark|ninja)-[a-z0-9-]+\/[A-Z0-9-]+\.html$/i,
    familySegment: 0,
    categorySegment: 1,
    gallerySelectors: [
      'img[src*="sharkninja-sfcc-prod-res.cloudinary.com"]',
    ],
  },
  // TODO (follow-up, 2026-06): Dyson extractor currently returns 0 images on every PDP
  // (28/28 PDPs with galleryImageCount: 0). Likely cause: dyson.com moved their image
  // CDN since the original crawl, or block-detection is firing on every page. The
  // extractor needs a fresh investigation — what host serves Dyson product images today,
  // and is the imageHost filter (or lack thereof — Dyson has none configured here)
  // letting them through? Probably need to set an imageHost for Dyson via the Add Brand
  // flow or hard-code one similar to how SharkNinja was handled.
  dyson: {
    name: 'Dyson',
    sitemaps: ['https://www.dyson.com/sitemapindex.xml'],
    pdpPattern: /\/[a-z-]+\/[a-z0-9-]+-\d+/i,
    familySegment: 0,
    categorySegment: 1,
    gallerySelectors: [
      '[class*="gallery"] img',
      '[class*="product-images"] img',
      '[class*="pdp"] img',
      '[data-gallery] img',
    ],
  },
  bissell: {
    name: 'Bissell',
    sitemaps: [
      'https://www.bissell.com/en-us/sitemap_0-product.xml',
    ],
    pdpPattern: /\/en-us\/product\/[a-z0-9%-]+-[a-z0-9]+\.html$/i,
    sampleSize: 200,
    familySegment: 2,
    categorySegment: 2,
    gallerySelectors: [
      '[class*="product-image"] img',
      '[class*="gallery"] img',
      '[class*="carousel"] img',
    ],
  },
  vitamix: {
    name: 'Vitamix',
    sitemaps: ['https://www.vitamix.com/us/en_us/products/sitemap.xml'],
    pdpPattern: /\/us\/en_us\/products\/[a-z0-9-]+/i,
    familySegment: 3,
    categorySegment: 3,
    gallerySelectors: [
      '[class*="product-gallery"] img',
      '[class*="pdp"] img',
      '[class*="carousel"] img',
    ],
  },
  williamssonoma: {
    name: 'Williams-Sonoma',
    // Product sitemap filtered by category keywords — no category in URL path
    sitemaps: ['https://www.williams-sonoma.com/netstorage/sitemaps/product-sitemap-1.xml.gz'],
    sitemapGzipped: true,
    pdpKeywords: /blender|stand-mixer|hand-mixer|espresso|coffee-maker|coffee-machine|toaster|kettle|waffle|juicer|food-processor|immersion-blender|air-fryer|pressure-cooker|slow-cooker|rice-cooker|electric|dehydrator|pasta-maker|sous-vide|citrus-press|ice-cream-maker|pan|pot|skillet|dutch-oven|wok|saucepan|saute-pan|braiser|stockpot|griddle|cast-iron|tagine|roasting-pan|fry-pan|cake-pan|muffin|loaf-pan|sheet-pan|cookie-sheet|tart-pan|pie-dish|springform|baking-dish|bundt|knife|knives|cleaver|sharpener|santoku/i,
    pdpPattern: /\/products\/[a-z0-9-]+\//i,
    sampleSize: 300,
    familySegment: 1,
    categorySegment: 1,
    useStealthBrowser: true,
    gallerySelectors: ['img.alt-image'],
  },
  breville: {
    name: 'Breville',
    // No XML sitemap for products — crawl category pages via Playwright
    categoryPages: [
      'https://www.breville.com/en-us/shop/espresso',
      'https://www.breville.com/en-us/shop/coffee',
      'https://www.breville.com/en-us/shop/ovens',
      'https://www.breville.com/en-us/shop/juicers',
      'https://www.breville.com/en-us/shop/blenders',
      'https://www.breville.com/en-us/shop/food-processors',
      'https://www.breville.com/en-us/shop/kettles',
      'https://www.breville.com/en-us/shop/toasters',
    ],
    pdpPattern: /\/en-us\/product\/[a-z0-9]+$/i,
    familySegment: 2,
    categorySegment: 2,
    gallerySelectors: [
      'img.hero-variant',
    ],
    // Breville's asset CDN namespaces gallery images by SKU (e.g. /BES995/...).
    // Enabling this filter rejects any captured src whose path doesn't contain the
    // SKU — defense against cross-sell carousels (which use other SKUs' paths) and
    // promo tiles slipping through the gallerySelectors scope.
    enforceSkuInPath: true,
  },
};

export const TARGET_BRANDS = ['sharkninja', 'breville', 'vitamix', 'williamssonoma'];

export const IMAGE_SCHEMA = {
  shotType:        ['hero', 'lifestyle', 'in_use', 'detail_closeup', 'exploded_view', 'packaging', 'unknown'],
  backgroundStyle: ['white', 'gradient', 'lifestyle_environment', 'studio_non_white', 'unknown'],
  subjectFocus:    ['product_only', 'product_and_person', 'product_and_food', 'product_and_mess', 'unknown'],
  angle:           ['front', 'three_quarter', 'top_down', 'side', 'rear', 'unknown'],
};
