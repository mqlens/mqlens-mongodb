// PNG masters are captured from the current UI. Keep every WebP in sync.
import sharp from 'sharp';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
for (const name of await readdir(`${publicDir}/screenshots`)) {
  if (!name.endsWith('.png')) continue;
  await sharp(`${publicDir}/screenshots/${name}`).webp({quality:85}).toFile(`${publicDir}/screenshots/${name.replace('.png','.webp')}`);
}
await sharp(`${publicDir}/screenshots/mqlens-documents.png`).jpeg({quality:85}).toFile(`${publicDir}/demo-poster.jpg`);
const preview = await sharp(`${publicDir}/screenshots/mqlens-workspace.png`).resize(1040).png().toBuffer();
const mark = (await readFile(`${publicDir}/favicon.svg`)).toString('base64');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#F6F8FC"/>
<image href="data:image/svg+xml;base64,${mark}" x="72" y="45" width="44" height="44"/>
<text x="130" y="78" font-family="sans-serif" font-size="30" font-weight="700" fill="#17243B">MQLens</text>
<text x="72" y="151" font-family="sans-serif" font-size="44" font-weight="700" fill="#17243B">Browse, query, and understand MongoDB.</text>
<text x="72" y="195" font-family="sans-serif" font-size="23" fill="#52627A">Free and open source · macOS, Windows &amp; Linux</text>
<rect x="72" y="234" width="1056" height="580" rx="10" fill="#DCE4EE"/>
<image href="data:image/png;base64,${preview.toString('base64')}" x="80" y="242" width="1040" height="650"/>
</svg>`;
await writeFile(`${publicDir}/og.svg`,svg);
await sharp(Buffer.from(svg)).png().toFile(`${publicDir}/og.png`);
console.log('Refreshed WebP variants, demo poster, and social preview.');
