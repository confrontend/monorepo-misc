const { execSync } = require("child_process");

try {
  execSync("npx @hey-api/openapi-ts", { stdio: "inherit" });
  console.log("✅ Client generation succeeded.");
} catch (err) {
  console.error("❌ Client generation failed.");
  console.error(err.message);
}
