const fs = require('fs');
const { execSync } = require('child_process');

const OUTPUT_DIR = 'generated/openapi-generator-cli';
const SPEC_PATH = 'openapi/enterprise-api.json';
const GENERATOR = 'typescript-fetch'; // or 'typescript-axios'

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

try {
  execSync(
    `npx @openapitools/openapi-generator-cli generate ` +
    `-i ${SPEC_PATH} -g ${GENERATOR} -o ${OUTPUT_DIR} ` +
    `--additional-properties=withSeparateModelsAndApi=true,api=false,supportsES6=true`,
    { stdio: 'inherit' }
  );
  console.log(`✅ TypeScript types generated (models only) using ${GENERATOR}`);
} catch (error) {
  console.error('❌ Failed to generate TypeScript types');
  console.error(error.message);
}
