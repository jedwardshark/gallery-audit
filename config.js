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
    // Tightened after seed-run inspection: original pattern caught 89 of ~187 accessory
    // PDPs. Added: accessor (kits), bundle (bundles), bulk-purchasing/flash-sale (B2B and
    // promo duplicates of real products), battery-pack, fl-oz/ounce (fluid sizing),
    // wipes, debris-basket / retrieva-hook (pool cleaner accessories), deshedding-kit.
    // Deliberately NOT included: `cleaner` (would false-positive real "vacuum-cleaner" /
    // "steam-cleaner" / "pool-cleaner" products), `station` (would false-positive real
    // Z-series station vacuums), `kit` alone (too broad). Verified zero false-positive
    // exclusions across all 9 borderline real products in the seed.
    pdpExcludeKeywords: /(brush|mop|filter|cleaning-solution|detergent|water-tank|dust-bag|spare-parts|cover-replacement|accessor|bundle|bulk-purchasing|flash-sale|battery-pack|fl-oz|ounce|wipes?|debris-basket|retrieva-hook|deshedding-kit|\d+pc)/i,
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
  miele: {
    name: 'Miele',
    // No accessible sitemap (Akamai serves a failover HTML page on /sitemap.xml).
    // Discovery happens via crawlBrand's categoryPages mechanism (Breville-style):
    // walk a top-level category list, harvest /product/<id>/<slug> links from each.
    // The category list below is the visible top-level appliance taxonomy at /search.
    categoryPages: [
      'https://www.mieleusa.com/category/1014414/ranges',
      'https://www.mieleusa.com/category/1022125/ovens',
      'https://www.mieleusa.com/category/1013128/combi-steam-ovens',
      'https://www.mieleusa.com/category/1013130/microwave-ovens',
      'https://www.mieleusa.com/category/1022127/warming-and-vacuum-sealing-drawers',
      'https://www.mieleusa.com/category/1013778/cooktops',
      'https://www.mieleusa.com/category/1014080/ventilation-hoods',
      'https://www.mieleusa.com/category/1013131/coffee-machines',
      'https://www.mieleusa.com/category/1014099/dishwashers',
      'https://www.mieleusa.com/category/1014098/refrigeration',
      'https://www.mieleusa.com/category/1014097/wine-conditioning',
      'https://www.mieleusa.com/category/1014096/washing-machines',
      'https://www.mieleusa.com/category/1014095/dryers',
      'https://www.mieleusa.com/category/1014094/vacuum-cleaners',
    ],
    pdpPattern: /\/product\/\d+\/[a-z0-9-]+/i,
    familySegment: 1,
    categorySegment: 1,
    // Miele uses Akamai bot protection — every page fetch must go through stealth
    // Playwright. The existing extractOnePdp path uses chromiumStealth, so we just
    // mark this brand as preferring stealth from the start.
    useStealthBrowser: true,
    // Image CDN — media.miele.com. cdn.cookielaw.org (cookie banner) and others are
    // filtered out by the imageHost constraint.
    imageHost: 'media.miele.com',
    // Deliberately NO gallerySelectors for V1. The [class*="_miele-gallery"] scope
    // only catches the hero carousel (2-6 images) and misses the rich below-fold
    // feature content (typically 25-60+ more images per PDP). Host-only filter
    // captures everything from media.miele.com — likely includes some related/
    // recommended-product imagery from compare modules, but that's a more useful
    // first cut than under-counting. TODO (follow-up): tighten with Miele-specific
    // section selectors once we audit and see what cross-sell pollution looks like.
  },
  dyson: {
    name: 'Dyson',
    sitemaps: ['https://www.dyson.com/sitemapindex.xml'],
    pdpPattern: /\/[a-z-]+\/[a-z0-9-]+-\d+/i,
    familySegment: 0,
    categorySegment: 1,
    // Dyson serves all product imagery from Adobe Experience Manager Dynamic Media
    // (dyson-h.assetsadobe2.com). Restricting imageHost to that domain filters out
    // chrome (logos, icons) and any third-party tracking pixels that leak through.
    imageHost: 'dyson-h.assetsadobe2.com',
    // Dyson's gallery uses BEM-style classes — product-gallery__thumbnail,
    // product-gallery__media, etc. The previous config's [class*="gallery"]
    // (lowercase, no "product-" prefix) failed to match because Dyson's classes
    // include a hyphen-separated namespace. The two selectors below were verified
    // across 5 product categories (vacuums, hair-care, air, headphones, fans) and
    // yield 18-23 distinct gallery images each, with no cross-sell leakage.
    gallerySelectors: [
      '[class*="product-gallery"] img',
      '.product-hero img',
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
