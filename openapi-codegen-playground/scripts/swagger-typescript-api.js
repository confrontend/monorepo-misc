const { mkdirSync } = require("fs");
const { execSync } = require("child_process");

const SPEC_PATH = "openapi/enterprise-api.json";
const OUTPUT_DIR = "generated/swagger-typescript-api";
const FILE_NAME = "api-types.ts";

mkdirSync(OUTPUT_DIR, { recursive: true });

const command = [
  "npx swagger-typescript-api generate",
  `-p ${SPEC_PATH}`,
  `-o ${OUTPUT_DIR}`,
  `-n ${FILE_NAME}`,
  "--modular --route-types --extract-request-body --extract-response-body",
].join(" ");

try {
  execSync(command, { stdio: "inherit" });
  console.log(
    "✅ Type-only API generated with swagger-typescript-api (modular and extracted)"
  );
} catch (error) {
  console.error("❌ Failed to generate types");
  console.error("Command:", command);
  console.error("Error:", error.message);
}
