# YRcine Android

Capacitor wrapper around the YRcine (VoidVerse) single-file web app.

- App ID: `com.yrcine.voidverse`
- Web assets live in `www/`
- Build: run the **Build YRcine APK** workflow (Actions tab). The signed APK is uploaded as the `YRcine-APK` artifact of each run.
- Signing key is stored as repository secrets (`KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`); updates stay signature-stable.
