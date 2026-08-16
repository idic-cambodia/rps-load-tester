#!/usr/bin/env node
// Usage: node scripts/generate-secrets-key.js
// Prints a base64-encoded 32-byte key to paste into SECRETS_ENCRYPTION_KEY in .env.
import crypto from "node:crypto";

console.log(crypto.randomBytes(32).toString("base64"));
