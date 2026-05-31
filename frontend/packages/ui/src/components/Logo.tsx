import { useId, type SVGProps } from 'react';
import clsx from 'clsx';

export interface LogoProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number | string;
  glow?: boolean;
}

/**
 * PetroBrain mark - a stylized 3D oil drop.
 *
 * Built from layered radial gradients (rim, body, sub-surface), a refracted
 * back-light, a specular highlight, and a contact shadow on the floor. The
 * geometry is the classic teardrop silhouette used in petroleum branding,
 * but rendered with enough lighting cues to read as a physical glossy
 * object rather than a flat icon.
 */
export function Logo({ size = 28, glow = false, className, ...rest }: LogoProps) {
  const reactId = useId().replace(/:/g, '');
  const gradBody = `pb-body-${reactId}`;
  const gradRim = `pb-rim-${reactId}`;
  const gradInner = `pb-inner-${reactId}`;
  const gradBackLight = `pb-back-${reactId}`;
  const gradSpec = `pb-spec-${reactId}`;
  const gradFloor = `pb-floor-${reactId}`;
  const dropClip = `pb-clip-${reactId}`;
  const innerShadow = `pb-ishadow-${reactId}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="PetroBrain"
      className={clsx(
        glow && 'drop-shadow-[0_10px_28px_rgba(234,88,12,0.45)]',
        className,
      )}
      {...rest}
    >
      <defs>
        {/* Outer rim - deeper at the edges, simulates Fresnel falloff */}
        <radialGradient id={gradRim} cx="50%" cy="55%" r="55%">
          <stop offset="60%" stopColor="#f97316" stopOpacity="0" />
          <stop offset="86%" stopColor="#7c2d12" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#431407" stopOpacity="0.85" />
        </radialGradient>

        {/* Core body gradient - warm orange volume */}
        <radialGradient id={gradBody} cx="40%" cy="32%" r="78%">
          <stop offset="0%" stopColor="#ffe2bf" />
          <stop offset="18%" stopColor="#ffbf80" />
          <stop offset="42%" stopColor="#f97316" />
          <stop offset="72%" stopColor="#c2410c" />
          <stop offset="100%" stopColor="#7c2d12" />
        </radialGradient>

        {/* Sub-surface caustic - gives the drop translucency */}
        <radialGradient id={gradInner} cx="62%" cy="70%" r="40%">
          <stop offset="0%" stopColor="#ffd6a3" stopOpacity="0.85" />
          <stop offset="60%" stopColor="#fb923c" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#fb923c" stopOpacity="0" />
        </radialGradient>

        {/* Back-light refraction near the bottom edge */}
        <radialGradient id={gradBackLight} cx="50%" cy="92%" r="30%">
          <stop offset="0%" stopColor="#fff0d9" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#fff0d9" stopOpacity="0" />
        </radialGradient>

        {/* Specular highlight - bright crescent up top-left */}
        <linearGradient id={gradSpec} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
          <stop offset="60%" stopColor="#ffffff" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>

        {/* Floor contact shadow */}
        <radialGradient id={gradFloor} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#431407" stopOpacity="0.45" />
          <stop offset="70%" stopColor="#431407" stopOpacity="0.08" />
          <stop offset="100%" stopColor="#431407" stopOpacity="0" />
        </radialGradient>

        {/* Inner shadow for ambient occlusion at the rim */}
        <filter id={innerShadow} x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="1.4" />
          <feOffset dx="0" dy="1.6" result="off" />
          <feComposite in="off" in2="SourceAlpha" operator="arithmetic" k2="-1" k3="1" result="shadowDiff" />
          <feColorMatrix
            in="shadowDiff"
            type="matrix"
            values="0 0 0 0 0.26
                    0 0 0 0 0.08
                    0 0 0 0 0.03
                    0 0 0 0.55 0"
          />
          <feComposite in2="SourceGraphic" operator="in" />
          <feMerge>
            <feMergeNode in="SourceGraphic" />
            <feMergeNode />
          </feMerge>
        </filter>

        {/* Clip to the drop silhouette so highlights / inner gradients
            never bleed past the body edge */}
        <clipPath id={dropClip}>
          <path d="M32 4 C32 4 11 27 11 41.5 a21 21 0 1 0 42 0 C53 27 32 4 32 4 Z" />
        </clipPath>
      </defs>

      {/* Floor contact shadow */}
      <ellipse cx="32" cy="60" rx="17" ry="2.6" fill={`url(#${gradFloor})`} />

      {/* Body silhouette */}
      <path
        d="M32 4 C32 4 11 27 11 41.5 a21 21 0 1 0 42 0 C53 27 32 4 32 4 Z"
        fill={`url(#${gradBody})`}
        filter={`url(#${innerShadow})`}
      />

      {/* All inner lighting is clipped to the drop shape */}
      <g clipPath={`url(#${dropClip})`}>
        {/* Sub-surface caustic on the lower right */}
        <ellipse cx="40" cy="46" rx="14" ry="10" fill={`url(#${gradInner})`} />

        {/* Back-light refraction near the base */}
        <ellipse cx="32" cy="55" rx="14" ry="6" fill={`url(#${gradBackLight})`} />

        {/* Rim darkening - Fresnel falloff at the silhouette edge */}
        <path
          d="M32 4 C32 4 11 27 11 41.5 a21 21 0 1 0 42 0 C53 27 32 4 32 4 Z"
          fill={`url(#${gradRim})`}
        />

        {/* Specular crescent (large, soft) */}
        <path
          d="M24 12 C18 22 14.5 31 14.5 39 C14.5 43.5 16.5 46.5 19.5 47.5 C18.5 41 21 31.5 27 21 C28.5 18 26 11 24 12 Z"
          fill={`url(#${gradSpec})`}
          opacity="0.9"
        />

        {/* Tight specular dot - sharpest highlight */}
        <ellipse
          cx="22.5"
          cy="22"
          rx="2.2"
          ry="3.6"
          fill="#ffffff"
          opacity="0.95"
          transform="rotate(-22 22.5 22)"
        />

        {/* Lower-right gloss reflection - small pool of light */}
        <ellipse
          cx="42"
          cy="50"
          rx="4.2"
          ry="2.4"
          fill="#ffffff"
          opacity="0.45"
          transform="rotate(-18 42 50)"
        />
      </g>
    </svg>
  );
}
