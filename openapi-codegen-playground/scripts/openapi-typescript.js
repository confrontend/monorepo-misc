const fs = require('fs');
const { execSync } = require('child_process');

const OUTPUT_PATH = 'generated/openapi-typescript/api.d.ts';
const SPEC_PATH = 'openapi/enterprise-api.json';

fs.mkdirSync('generated/types', { recursive: true });

try {
  execSync(
    `npx openapi-typescript ${SPEC_PATH} --output ${OUTPUT_PATH}`,
    { stdio: 'inherit' }
  );
  console.log('✅ TypeScript types generated from OpenAPI spec');
} catch (error) {
  console.error('❌ Failed to generate types');
  console.error(error.message);
}
