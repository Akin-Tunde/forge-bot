import { ensureDir } from 'fs-extra';
import { join } from 'path';

async function prepareDist() {
  try {
    await ensureDir(join('dist', 'landing-pages'));
    console.log('✅ Created dist/landing-pages directory');
  } catch (error) {
    console.error('❌ Error creating directories:', error);
    process.exit(1);
  }
}

prepareDist();