/** Small identity images are stored with the profile. Provider URLs stay URLs. */
export function parseImageSource(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 65_536) {
    throw new TypeError("Invalid image");
  }
  if (value.startsWith("data:")) {
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/
      .exec(value);
    if (!match || match[2].length % 4 !== 0) {
      throw new TypeError("Use a PNG, JPEG or WebP image");
    }
    const bytes = atob(match[2]);
    if (btoa(bytes) !== match[2]) throw new TypeError("Invalid image encoding");
    const valid = match[1] === "png"
      ? bytes.startsWith("\x89PNG\r\n\x1a\n")
      : match[1] === "jpeg"
      ? bytes.startsWith("\xff\xd8\xff")
      : bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP";
    if (!valid || bytes.length < 16) throw new TypeError("Invalid image file");
    return value;
  }
  const url = new URL(value);
  if (
    value.length > 2048 || url.protocol !== "https:" || url.username ||
    url.password
  ) throw new TypeError("Use an HTTPS image URL");
  return url.href;
}
