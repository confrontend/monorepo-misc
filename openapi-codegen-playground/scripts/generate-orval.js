const { execSync } = require('child_process');

execSync('npx orval --config orval.config.js', { stdio: 'inherit' });
