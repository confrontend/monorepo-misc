# Validation Quickstart

From `crypto/`:

```powershell
npm run build:server
node --test dist/tests/transfer-inventory.test.js dist/tests/copytrade.test.js
npm run arch:check
```

The transfer test must cover:

1. normal buy → sell: profit remains unchanged;
2. TX In → sell: sell is uncertain and excluded;
3. buy + TX In → sell: transfer-backed portion is excluded conservatively;
4. partial transfer-in + partial sell: only provable buy-backed quantity can count;
5. TX In with no sell: no realized result is emitted.

Also verify a captured production GMGN request includes transfer events and that the stored raw payload retains the source event spelling.
