import * as fs from 'fs';
import * as path from 'path';

const distDir = path.resolve('dist');
const binariesDir = path.join(distDir, 'binaries');

// Create dist/binaries and replicate the required ESM files
fs.mkdirSync(binariesDir, { recursive: true });
fs.copyFileSync(path.join(distDir, 'cli.js'), path.join(binariesDir, 'cli.js'));
fs.copyFileSync(path.join(distDir, 'agent.js'), path.join(binariesDir, 'agent.js'));

const toolsDir = path.join(binariesDir, 'tools');
fs.mkdirSync(toolsDir, { recursive: true });
fs.copyFileSync(path.join(distDir, 'tools', 'index.js'), path.join(toolsDir, 'index.js'));

console.log('✓ Successfully replicated build files into dist/binaries/ structure');
