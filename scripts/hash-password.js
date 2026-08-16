#!/usr/bin/env node
// Usage: node scripts/hash-password.js <plaintext-password>
// Prints a bcrypt hash to paste into ADMIN_PASSWORD_HASH in .env.
import bcrypt from "bcryptjs";

const password = process.argv[2];
if (!password) {
  console.error("Usage: node scripts/hash-password.js <plaintext-password>");
  process.exit(1);
}
console.log(bcrypt.hashSync(password, 12));
