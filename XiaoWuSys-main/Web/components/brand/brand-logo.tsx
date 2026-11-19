// XiaoWuSys brand mark. Two artworks, picked by the theme with CSS only (no JS, no flash):
//   light mode -> the black cloud (white lettering) stands out on light surfaces
//   dark mode  -> the white cloud (navy lettering) stands out on dark surfaces
// Both images are in the DOM; `dark:` classes show exactly one, so the swap follows the
// <html class="dark"> toggle instantly.
//
// loading="eager": the logo is always above the fold (header, login card, the full-screen
// loading spinner) and Next.js reports it as the Largest Contentful Paint. Eager loading fetches
// both artworks (about 30 KB each, then cached for every other use of the logo); that is the
// price of a theme swap with no flash. Next.js 16 says not to combine `preload` with `loading`,
// so this replaces the old per-caller `preload` flag.
import Image from 'next/image';
import { cn } from '@/lib/utils';

export const APP_NAME = 'XiaoWuSys';

// Source artwork is 1587×895; the files in public/brand are 640px wide.
const LOGO_WIDTH = 640;
const LOGO_HEIGHT = 361;

export function BrandLogo({
  className,
  alt = `${APP_NAME} logo`,
}: {
  /** Size it with a height (e.g. "h-8"); the width follows the aspect ratio. */
  className?: string;
  /** Pass "" when a visible app name sits right next to the logo (decorative). */
  alt?: string;
}) {
  const shared = cn('w-auto shrink-0 select-none', className);
  return (
    <>
      <Image
        src="/brand/xws-logo-black.png"
        alt={alt}
        width={LOGO_WIDTH}
        height={LOGO_HEIGHT}
        loading="eager"
        draggable={false}
        className={cn(shared, 'dark:hidden')}
      />
      <Image
        src="/brand/xws-logo-white.png"
        alt={alt}
        width={LOGO_WIDTH}
        height={LOGO_HEIGHT}
        loading="eager"
        draggable={false}
        className={cn(shared, 'hidden dark:block')}
      />
    </>
  );
}

/**
 * Centered "something is loading" indicator: the logo spinning at a medium pace (1.6s per turn),
 * with a text label so the state is never conveyed by motion alone. Users who ask the OS for
 * reduced motion get a gentle pulse instead of a spin.
 */
export function LogoSpinner({
  label = 'Loading…',
  className,
  size = 'md',
}: {
  label?: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const logoSize = { sm: 'h-8', md: 'h-12', lg: 'h-16' }[size];
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('flex flex-col items-center justify-center gap-3 py-10 text-sm text-muted-foreground', className)}
    >
      <span className="xws-logo-spin flex items-center justify-center" aria-hidden>
        <BrandLogo alt="" className={logoSize} />
      </span>
      <span>{label}</span>
    </div>
  );
}
