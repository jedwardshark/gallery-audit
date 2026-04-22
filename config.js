export const BRANDS = {
  sharkninja: {
    name: 'SharkNinja',
    sitemaps: [
      'https://www.sharkninja.com/sitemap_index.xml',
      'https://www.sharkninja.com/sitemaps/sitemap.xml',
    ],
    pdpPattern: /\/(shark|ninja)-[a-z0-9-]+-[a-z]{2}\d+/i,
    familySegment: 0,
    categorySegment: 1,
    gallerySelectors: [
      'img[src*="sharkninja-sfcc-prod-res.cloudinary.com"]',
    ],
  },
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
  },
};

export const TARGET_BRANDS = ['sharkninja', 'breville', 'vitamix', 'williamssonoma'];

export const IMAGE_SCHEMA = {
  shotType:        ['hero', 'lifestyle', 'in_use', 'detail_closeup', 'exploded_view', 'packaging', 'unknown'],
  backgroundStyle: ['white', 'gradient', 'lifestyle_environment', 'studio_non_white', 'unknown'],
  subjectFocus:    ['product_only', 'product_and_person', 'product_and_food', 'product_and_mess', 'unknown'],
  angle:           ['front', 'three_quarter', 'top_down', 'side', 'rear', 'unknown'],
};
