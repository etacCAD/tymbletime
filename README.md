# TymbleTime 🎀

Password-protected gymnastics coaching reviews.

`index.html` holds the review encrypted with AES-256-GCM (key from PBKDF2-SHA256, 600k iterations). The readable source (`private/`), the videos and the password are never committed. The page decrypts in the browser once you enter the password.

**Rebuild after editing `private/report.html`:**

```bash
TT_PASSWORD='…' node build.mjs
```
