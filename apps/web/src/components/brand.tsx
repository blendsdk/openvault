/**
 * The OpenVault vault-dial mark.
 *
 * The image is decorative; the surrounding link or heading supplies the
 * accessible name. The same SVG is served as the browser favicon.
 *
 * @param props - Optional rendered size in CSS pixels.
 * @returns The brand image.
 *
 * @example
 * ```tsx
 * <a href="/" aria-label="OpenVault home">
 *   <BrandMark />
 * </a>
 * ```
 */
export function BrandMark({ size = 32 }: { readonly size?: number }) {
  return (
    <img
      className="brand-mark"
      src="/logo.svg"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
