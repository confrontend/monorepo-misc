const fs = require('fs');
const { execSync } = require('child_process');

fs.mkdirSync('generated/rtk', { recursive: true });

execSync('npx @rtk-query/codegen-openapi rtk-codegen.config.json', { stdio: 'inherit' });
