import { constants } from "node:fs";
import { open, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type AtomicWriteOptions = {
  simulateCrashAfterTempWrite?: boolean;
};

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const handle = await open(filePath, constants.O_RDONLY);
    await handle.close();
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function fsyncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function fsyncDir(dirPath: string): Promise<void> {
  const handle = await open(dirPath, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeFileAtomic(
  targetPath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmp = path.join(dir, `.${base}.tmp.${process.pid}.${randomUUID()}`);

  await writeFile(tmp, content, "utf8");
  await fsyncFile(tmp);

  if (options.simulateCrashAfterTempWrite) {
    throw new Error(`simulated crash after writing ${tmp}`);
  }

  await rename(tmp, targetPath);
  await fsyncDir(dir);
}

export async function removeFileIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
