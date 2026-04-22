import { chromium } from 'playwright';
import fs from 'fs';

const TEST_URL = 'https://www.sharkninja.com/ninja-flexflame-proconnect-smart-cooking-system-pg305/PG305B1.html';
console.log('Testing URL:', TEST_URL);

const browser = await chromium.launch({ headless: false }); // visible so you can see it
const page = await browser.newPage();
await page.goto(TEST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(3000);

const imgData = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('img')).map(img => ({
    src: img.src?.slice(0, 80),
    alt: img.alt?.slice(0, 50),
    width: img.naturalWidth || img.width,
    classes: img.className,
    parentClass: img.parentElement?.className?.slice(0, 80),
    grandparentClass: img.parentElement?.parentElement?.className?.slice(0, 80),
  }));
});

console.table(imgData.filter(i => i.width > 200));
await browser.close();
