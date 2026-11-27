// Uploads everything in /frontend to the S3 website bucket on Floci.
// Usage: npm run deploy:web   ->  http://localhost:4566/esp-frontend/index.html
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { AWS, RESOURCES } = require('../shared/config');

const s3 = new S3Client({ ...AWS, forcePathStyle: true });
const ROOT = path.join(__dirname, '..', '..', 'frontend');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.csv': 'text/csv' };

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}

(async () => {
  const files = walk(ROOT);
  for (const file of files) {
    const key = path.relative(ROOT, file).split(path.sep).join('/');
    await s3.send(new PutObjectCommand({
      Bucket: RESOURCES.buckets.web, Key: key, Body: fs.readFileSync(file),
      ContentType: TYPES[path.extname(file)] || 'application/octet-stream', CacheControl: 'no-cache',
    }));
    console.log(`  uploaded ${key}`);
  }
  console.log(`\n${files.length} files -> http://localhost:4566/${RESOURCES.buckets.web}/index.html`);
})().catch((e) => { console.error('deploy failed:', e.message); process.exit(1); });
