import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { logger } from './util/logger';

const execAsync = promisify(exec);

function screenshotDir(): string {
  const dir = path.join(os.tmpdir(), "clawbot-screenshots");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function captureRaw(): Promise<string> {
  const filename = `screenshot_${Date.now()}.png`;
  const filePath = path.join(screenshotDir(), filename);
  const platform = os.platform();

  if (platform === "darwin") {
    const captureTool = path.join(__dirname, "..", "scripts", "capture-cursor");
    let captured = false;
    if (fs.existsSync(captureTool)) {
      try {
        const { stdout } = await execAsync(`"${captureTool}" "${filePath}"`);
        if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) {
          captured = true;
          logger.info({ output: stdout.trim() }, "captured Cursor window via ScreenCaptureKit");
        }
      } catch (err) {
        logger.warn({ err: String(err) }, "ScreenCaptureKit capture failed, falling back to screencapture");
      }
    }
    if (!captured) {
      await execAsync(`screencapture -x "${filePath}"`);
      logger.info("captured full screen (fallback)");
    }
  } else if (platform === "win32") {
    const ps = `
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
      $bmp.Save('${filePath.replace(/\\/g, "\\\\")}')
      $g.Dispose()
      $bmp.Dispose()
    `.trim();
    await execAsync(`powershell -Command "${ps.replace(/"/g, '\\"')}"`);
  } else if (platform === "linux") {
    try {
      await execAsync(`gnome-screenshot -f "${filePath}" 2>/dev/null`);
    } catch {
      await execAsync(`import -window root "${filePath}"`);
    }
  } else {
    throw new Error(`Screenshot not supported on ${platform}`);
  }

  if (!fs.existsSync(filePath)) {
    throw new Error("Screenshot file was not created");
  }
  return filePath;
}

async function compressToJpeg(pngPath: string, quality = 60): Promise<string> {
  const jpegPath = pngPath.replace(/\.png$/, ".jpg");
  const platform = os.platform();

  if (platform === "darwin") {
    await execAsync(
      `sips -s format jpeg -s formatOptions ${quality} "${pngPath}" --out "${jpegPath}" 2>/dev/null`,
    );
  } else {
    try {
      await execAsync(`convert "${pngPath}" -quality ${quality} "${jpegPath}"`);
    } catch {
      return pngPath;
    }
  }

  if (fs.existsSync(jpegPath)) {
    try { fs.unlinkSync(pngPath); } catch { /* */ }
    return jpegPath;
  }
  return pngPath;
}

export async function captureScreen(): Promise<string> {
  const rawPath = await captureRaw();
  const rawSize = fs.statSync(rawPath).size;
  const compressed = await compressToJpeg(rawPath);
  const finalSize = fs.statSync(compressed).size;

  logger.info(
    { path: compressed, rawSize, finalSize, ratio: `${((finalSize / rawSize) * 100).toFixed(1)}%` },
    "screenshot captured",
  );
  return compressed;
}

export async function captureAndCleanup(maxAge = 300_000): Promise<string> {
  const dir = screenshotDir();
  const now = Date.now();
  try {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > maxAge) {
        fs.unlinkSync(fp);
      }
    }
  } catch { /* best effort */ }

  return captureScreen();
}
