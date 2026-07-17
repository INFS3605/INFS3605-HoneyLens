import { mkdirSync, writeFileSync } from "node:fs";

const supabaseUrl = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !publishableKey) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY environment variable."
  );
}

mkdirSync("js", { recursive: true });

const config = `window.OOXII_CONFIG = {
  SUPABASE_URL: ${JSON.stringify(supabaseUrl)},
  SUPABASE_PUBLISHABLE_KEY: ${JSON.stringify(publishableKey)}
};
`;

writeFileSync("js/config.js", config, "utf8");

console.log("Generated js/config.js successfully.");
