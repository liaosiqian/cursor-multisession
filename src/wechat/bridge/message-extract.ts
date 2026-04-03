import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MessageItemType, type WeixinMessage, type MessageItem } from '../api/types';
import { MediaService } from '../media/index';
import { logger } from '../util/logger';

const MULTISESSION_DIR = path.join(os.homedir(), ".multisession");

export interface ExtractedContent {
  text: string;
  imagePaths: string[];
}

function imagesDir(sessionId: string): string {
  const dir = path.join(MULTISESSION_DIR, "sessions", sessionId, "images");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Extract all content from a WeChat message:
 * - Text items → concatenated text
 * - Voice items → voice-to-text transcription
 * - Image items → download and save to MultiSession images dir
 */
export async function extractMessage(
  msg: WeixinMessage,
  sessionId: string,
  mediaService: MediaService,
): Promise<ExtractedContent> {
  const texts: string[] = [];
  const imagePaths: string[] = [];

  if (!msg.item_list) {
    return { text: "", imagePaths: [] };
  }

  for (const item of msg.item_list) {
    switch (item.type) {
      case MessageItemType.TEXT:
        if (item.text_item?.text) {
          texts.push(item.text_item.text);
        }
        break;

      case MessageItemType.VOICE:
        if (item.voice_item?.text) {
          texts.push(`[语音] ${item.voice_item.text}`);
        } else {
          texts.push("[语音消息（无转文字）]");
        }
        break;

      case MessageItemType.IMAGE:
        try {
          const imgPath = await downloadImage(item, sessionId, mediaService);
          if (imgPath) {
            imagePaths.push(imgPath);
            texts.push(`[图片] ${imgPath}`);
          }
        } catch (err) {
          logger.error({ err: String(err) }, "failed to download image");
          texts.push("[图片下载失败]");
        }
        break;

      case MessageItemType.FILE:
        if (item.file_item?.file_name) {
          texts.push(`[文件] ${item.file_item.file_name}`);
        } else {
          texts.push("[文件]");
        }
        break;

      case MessageItemType.VIDEO:
        texts.push("[视频]");
        break;

      default:
        break;
    }
  }

  return {
    text: texts.join("\n"),
    imagePaths,
  };
}

async function downloadImage(
  item: MessageItem,
  sessionId: string,
  mediaService: MediaService,
): Promise<string | null> {
  const media = item.image_item?.media;
  if (!media?.full_url) return null;

  const aesKey = item.image_item?.aeskey || media.aes_key;
  const data = await mediaService.download(media, aesKey);

  const dir = imagesDir(sessionId);
  const filename = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, data);

  logger.info({ filePath, size: data.length }, "image saved");
  return filePath;
}
