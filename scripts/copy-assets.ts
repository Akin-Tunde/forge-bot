import { copy, pathExists } from 'fs-extra';
import { join } from 'path';

async function copyAssets() {
  try {
    const srcDir = join('src', 'landing-pages');
    const destDir = join('dist', 'landing-pages');
    
    if (await pathExists(srcDir)) {
      await copy(srcDir, destDir);
      console.log('✅ Landing pages copied successfully');
    } else {
      console.log('ℹ️ No landing pages to copy');
    }
  } catch (error) {
    console.error('❌ Error copying assets:', error);
    process.exit(1);
  }
}

copyAssets();