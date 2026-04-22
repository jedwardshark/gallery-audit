import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import fs from 'fs';
import pLimit from 'p-limit';
import 'dotenv/config';
import { IMAGE_SCHEMA } from './config.js';

const client = new Anthropic();
const API_LIMIT = pLimit(3);

const SYSTEM_PROMPT = `You are a product photography analyst auditing e-commerce PDP gallery images.
For each image, classify it across exactly these 5 dimensions.
Return ONLY valid JSON — no preamble, no markdown fences.`;

function buildPrompt(brand, family, category, position, totalInGallery) {
  return `Classify this PDP gallery image for ${brand} — product family: "${family}", category: "${category}".
This is image ${position} of ${totalInGallery} in the gallery sequence.

Return ONLY this JSON structure with no other text:
{
  "shotType": ${JSON.stringify(IMAGE_SCHEMA.shotType)},
  "backgroundStyle": ${JSON.stringify(IMAGE_SCHEMA.backgroundStyle)},
  "subjectFocus": ${JSON.stringify(IMAGE_SCHEMA.subjectFocus)},
  "angle": ${JSON.stringify(IMAGE_SCHEMA.angle)},
  "sequenceRole": "opening|supporting|detail|closing|unknown",
  "confidence": "high|medium|low",
  "notes": "<10 words max>"
}

Pick exactly ONE value per field from the arrays shown.
sequenceRole: opening = first impression; supporting = reinforces hero; detail = closeup feature; closing = CTA/lifestyle payoff.`;
}

async function classifyImage(imageUrl, brand, family, category, position, total) {
  let base64, mediaType;
  try {
    const resp = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    base64 = Buffer.from(resp.data).toString('base64');
    mediaType = resp.headers['content-type']?.split(';')[0] || 'image/jpeg';
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mediaType)) {
      mediaType = 'image/jpeg';
    }
  } catch (e) {
    return { error: `Image fetch failed: ${e.message}` };
  }

  const res = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: buildPrompt(brand, family, category, position, total) }
      ]
    }]
  });

  const raw = res.content[0].text.replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

async function classifyAll() {
  const galleryData = JSON.parse(fs.readFileSync('data/gallery_raw.json'));

  const tasks = [];
  for (const pdp of galleryData) {
    if (!pdp.images?.length) continue;
    for (const img of pdp.images) {
      tasks.push({
        pdpUrl: pdp.url,
        brand: pdp.brand,
        brandName: pdp.brandName,
        family: pdp.family,
        category: pdp.category,
        imageUrl: img.src,
        imageAlt: img.alt,
        imageWidth: img.width,
        imageHeight: img.height,
        sequencePosition: img.sequencePosition,
        totalImagesInGallery: pdp.galleryImageCount,
      });
    }
  }

  console.log(`🤖 Classifying ${tasks.length} images with Claude Vision...`);
  let done = 0;
  const results = [];

  await Promise.all(tasks.map(task => API_LIMIT(async () => {
    try {
      const classification = await classifyImage(
        task.imageUrl,
        task.brandName,
        task.family,
        task.category,
        task.sequencePosition,
        task.totalImagesInGallery
      );
      results.push({ ...task, ...classification });
    } catch (e) {
      results.push({ ...task, error: e.message });
    }
    done++;
    if (done % 10 === 0) process.stdout.write(`\r  ${done}/${tasks.length} images classified...`);
  })));

  fs.writeFileSync('data/classifications.json', JSON.stringify(results, null, 2));
  console.log(`\n✅ Classification complete. ${results.length} images classified.`);
  console.log('   Saved to data/classifications.json');
}

classifyAll();
