import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let version = 'unknown';
try {
  // From src/config/version.ts, package.json is at ../../package.json
  // But wait, after build, it might be in dist/config/version.js, so package.json is at ../../package.json
  const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  version = pkg.version;
} catch (e) {
  try {
    // Fallback if built flat
    const pkgPathAlt = path.resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPathAlt, 'utf8'));
    version = pkg.version;
  } catch(e2) {
    version = '1.0.7'; // safe fallback
  }
}

export const GIGA_VERSION = version;
