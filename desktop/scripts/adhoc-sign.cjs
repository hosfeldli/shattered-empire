// macOS: Apple Silicon refuses to run unsigned code, and packaging invalidates Electron's own
// signature. Without a Developer ID, sign the packed app ad hoc so it launches (first launch:
// right-click -> Open). With a real identity configured, electron-builder signs and this is skipped.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
exports.default = async function adhocSign(ctx) {
  if (ctx.electronPlatformName !== 'darwin' || process.env.CSC_LINK) return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
