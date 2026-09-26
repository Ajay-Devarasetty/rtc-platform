# SDK release gates

Run `node scripts/verify-release.mjs` from the repository root. It builds and tests the JavaScript packages and checks package contents without publishing them.

The 2026-09-25 Android candidate brings the tested demo's ICE/TURN configuration, queued join, ICE buffering, call diagnostics, audio lifecycle, and aspect-fit video renderer into the main SDK. Flutter Android exposes the video platform view and message history bridge. React Native Android registers its video view and uses the tested device event path; iOS retains its existing event emitter and method signature.

The complete production SFU engine is retained. Do not copy the demo's SFU stub over it. Native compilation and P2P/SFU coexistence must be verified before publishing this candidate.

Before any public version:

1. Build Android library and both wrappers against their supported toolchains; run iOS builds on macOS.
2. Test Flutter ↔ Flutter, React Native ↔ React Native, Flutter ↔ React Native, and mobile ↔ web. Include voice, video, history, reconnect, permissions denied, and network switches.
3. Check package archives exclude build caches, credentials, demo keys, and recordings.
4. Update package version, lockfile, changelog, and supported-platform matrix together. Publish only validated packages.

Current packages remain development candidates at their existing versions. No registry publication or APK build is part of these changes.
