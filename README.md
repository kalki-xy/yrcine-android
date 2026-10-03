# YRcine Android

Capacitor native shell around the YRcine single-file app.

- **App ID:** `com.yrcine.voidverse`
- **Web assets:** `www/`
- **Stream API:** `https://yrcine-consumet-api.vercel.app`

## Build APK (GitHub Actions)

1. Open → https://github.com/kalki-xy/yrcine-android/actions
2. Select workflow **Build YRcine APK**
3. Click **Run workflow**
4. Download artifact **YRcine-APK** when finished

Requires secrets: `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`

## Local build

```bash
npm ci
npx cap sync android
cd android && ./gradlew assembleRelease
```

## API endpoints used by the app

- `/search?q=&type=anime|manga|music|all`
- `/manhwa?region=KR|JP|CN`
- `/music/search?q=`
- `/downloads` — APK / HTML links shown in Downloads section
