/**
 * Browser-side PEM helpers.
 *
 * PEM files are read and written locally. Nothing here writes to local
 * storage, session storage, cookies, or the clipboard.
 */

/**
 * Reads a local PEM file and rejects files above the limit.
 *
 * The file never leaves the browser: the caller receives the text and sends it
 * through the normal JSON request. The checks catch an empty file, an
 * oversized file, and a file that is not PEM-shaped before a request is made.
 *
 * @param file - File chosen from the operator's computer.
 * @param maxBytes - Maximum accepted byte size.
 * @returns The file text.
 * @throws {Error} When the file is empty, too large, unreadable, or has no PEM marker.
 *
 * @example
 * ```ts
 * const pem = await readPemFile(file, 256 * 1024);
 * ```
 */
export function readPemFile(file: File, maxBytes: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (file.size === 0) {
      reject(new Error("The selected file is empty"));
      return;
    }
    if (file.size > maxBytes) {
      reject(new Error("The selected file is larger than the allowed limit"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error("The selected file could not be read"));
    };
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      if (!text.includes("-----BEGIN ")) {
        reject(new Error("The selected file does not contain a PEM block"));
        return;
      }
      resolve(text);
    };
    reader.readAsText(file);
  });
}

/**
 * Downloads text as a file without persisting it in browser storage.
 *
 * The blob URL exists only for the click and is revoked immediately, so the
 * text is not addressable after the download starts.
 *
 * @param filename - Suggested file name.
 * @param text - File contents.
 *
 * @example
 * ```ts
 * downloadPem("api-tls-certificate.pem", certificatePem);
 * ```
 */
export function downloadPem(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/x-pem-file" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}
